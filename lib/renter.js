'use strict';

var storj = require('storj-lib');
var MongoStorageAdapter = require('storj-mongodb-adapter');
var ReadableStream = require('readable-stream');
var inherits = require('util').inherits;
var rabbitmq = require('rabbit.js');
var Logger = require('kad-logger-json');
var uuid = require('node-uuid');

/**
 * Create a renter interface capable of coordinating with other renters
 * @constructor
 * @param {Object} options
 *
 */
function Renter(options) {
  if (!(this instanceof Renter)) {
    return new Renter(options);
  }

  this._opts = options;
  this._logger = new Logger(this._opts.logLevel);

  ReadableStream.call(this);
}

inherits(Renter, ReadableStream);

Renter.SAFE_LANDLORD_METHODS = [
  'getConsignmentPointer',
  'getRetrievalPointer',
  'getMirrorNodes',
  'getStorageOffer',
  'getStorageProof'
];

Renter.SAFE_POOL_METHODS = [
  'isAwaitingOffer',
  'endContractNegotiation'
];

Renter.POOL_REQUEST_TIMEOUT = 5000;

/**
 * Starts the renter service
 * @param {Renter~startCallback}
 */
Renter.prototype.start = function(callback) {
  // Set up our database connection for shared contract storage
  this.storage = mongoose.connect(this._opts.mongoUrl, this._opts.mongoOpts);

  // Set up our RabbitMQ context
  this.messaging = rabbitmq.createContext(
    this._opts.amqpUrl,
    this._opts.amqpOpts
  );

  // Set up our network interface to Storj
  this.network = storj.RenterInterface({
    storageManager: storj.StorageManager(MongoStorageAdapter(this.storage)),
    rpcPort: this._opts.networkOpts.rpcPort,
    rpcAddress: this._opts.networkOpts.rpcAddress,
    keyPair: storj.KeyPair(this._opts.networkOpts.privateKey),
    doNotTraverseNat: true,
    maxTunnels: this._opts.networkOpts.maxTunnels,
    tunnelGatewayRange: this._opts.networkOpts.tunnelGatewayRange,
    bridgeUri: this._opts.networkOpts.bridgeUri,
    logger: this._logger
  });

  // When our context is good, set up our subscriptions
  this._amqpContext.on('ready', this._initMessageBus.bind(this));

  // When we are all connected, fire the callback
  this.once('ready', function() {
    this.removeAllListeners('error');
    callback();
  });

  // Otherwise bubble any errors
  this.once('error', function(err) {
    this.removeAllListeners('ready');
    callback(err);
  });
};
/**
 * @callback Renter~startCallback
 * @param {Error} [error]
 */

/**
 * Initialize the rabbitmq message bus
 * @private
 */
Renter.prototype._initMessageBus = function() {
  // Setup our amqp sockets
  this.publisher = this._amqpContext.socket('PUBLISH');
  this.subscriber = this._amqpContext.socket('SUBSCRIBE');
  this.worker = this._amqpContext.socket('WORKER');

  // Connect to our renter friends and our landlord
  this.publisher.connect('pool', 'work.close');
  this.subscriber.connect('pool');
  this.worker.connect('work.open');

  // Set up handlers for receiving work
  // Set up handlers for renter alerts
  this.worker.on('data', this._handleWork.bind(this));
  this.subscriber.on('data', this._handleAlert.bind(this));

  // Set up our internal alerts for other renters
  this._handleNetworkEvents();
};

/**
 * Listens for network events and fires their appropriate handlers
 * @private
 */
Renter.prototype._handleNetworkEvents = function() {
  // Listen for unhandled offers and alert our renter friends
  // Listen for resolved unhandled offers and alert our renter friends
  this.network.on('unhandledOffer', this._onUnhandledOffer.bind(this));
  this.network.on('unhandledOfferResolved', this._onResolvedOffer.bind(this));

  // Good to go!
  this.emit('ready');
};

/**
 * Handles work received from a landlord
 * @private
 */
Renter.prototype._handleWork = function(data) {
  var self = this;

  // Acknowledge we have received the work
  this.worker.ack();

  if (Renter.SAFE_LANDLORD_METHODS.indexOf(data.method) === -1) {
    return this.publisher.publish('work.close', {
      id: data.id,
      error: {
        code: -32601,
        message: 'Method not found'
      }
    });
  }

  data.params.push(function() {
    var args = self._serializeArguments(data.method, arguments);

    if (args[0]) {
      return self.publisher.publish('work.close', {
        id: data.id,
        error: {
          code: -32603,
          message: args[0].message
        }
      })
    }

    self.publisher.publish('work.close', {
      id: data.id,
      result: args
    });
  });

  this.network[data.method].apply(
    this.network,
    this._deserializeArguments(data.method, data.params)
  );
};

/**
 * Handles alerts from other renters
 * @private
 */
Renter.prototype._handleAlert = function(data) {
  var self = this;

  // If this is a response to us and we are waiting, call our callback
  if (this._pendingCallbacks[data.id]) {
    return this._pendingCallbacks[data.id].apply(null, data.result);
  }

  // If this is a request and it's not allowed, do nothing
  if (Renter.SAFE_POOL_METHODS.indexOf(data.method) === -1) {
    return;
  };

  // Add a callback function to the supplied params that only publishes
  // a response if the result is positive
  data.params.push(function(err, isAwaitingOfferOrDidEndNegotiation) {
    if (err || !isAwaitingOfferOrDidEndNegotiation) {
      return;
    }

    self.publisher.publish('pool', {
      id: data.id,
      result: [null, true]
    });
  });

  // Call the method on the network interface
  this.network[data.method].apply(this.network, data.params);
};

/**
 * Alert our renter friends when we get an unhandled offer
 * @private
 */
Renter.prototype._onUnhandledOffer = function(contract, contact, resolver) {
  var self = this;
  var callbackId = uuid.v4();

  // Set up a callback for waiting on a response for the pool
  this._pendingCallbacks[callbackId] = function(err, isAwaiting) {
    resolver(
      err || (!isAwaiting ? new Error('Failed to handle offer') : null)
    );
  };

  // Ask the pool if any of our renter friends are waiting on an offer
  this.publisher.publish('pool', {
    id: callbackId,
    method: 'isAwaitingOffer',
    params: [
      contract.get('data_hash')
    ]
  });

  setTimeout(function() {
    if (self._pendingCallbacks[callbackId]) {
      self._pendingCallbacks[callbackId](
        new Error('No renters in pool are waiting for offer')
      );
    }
  }, Renter.POOL_REQUEST_TIMEOUT);
};

/**
 * Another renter resolved our unhandled offer
 * @private
 */
Renter.prototype._onResolvedOffer = function(contract) {
  var callbackId = uuid.v4();

  this.publisher.publish('pool', {
    id: callbackId,
    method: 'endContractNegotiation',
    params: [contract.get('data_hash')]
  });
};

/**
 * Deserializes the arguments passed back to the bus
 * @param {String} method - The method name to call
 * @param {Array} argmuments - The arguments passed to the method
 * @returns {Array} args
 */
Renter.prototype._deserializeArguments = function(method, args) {
  switch (method) {
    case 'getConsignmentPointer':
      args[0] = storj.Contact(args[0]);
      args[1] = storj.Contract.fromObject(args[1]);
      args[2] = storj.AuditStream.fromRecords(
        args[2].challenges,
        args[2].tree
      );
      break;
    case 'getRetrievalPointer':
      args[0] = storj.Contact(args[0]);
      args[1] = storj.Contract.fromObject(args[1]);
      break;
    case 'getMirrorNodes':
      args[0] = args[0].map(function(pointerData) {
        return storj.DataChannelPointer(
          storj.Contact(pointerData.contact),
          pointerData.hash,
          pointerData.token,
          pointerData.operation
        );
      });
      args[1] = args[1].map(function(contactData) {
        return storj.Contact(contactData);
      });
      break;
    case 'getStorageProof':
      args[0] = storj.Contact(args[0]);
      args[1] = storj.StorageItem(args[1]);
      break;
    case 'getStorageOffer':
      args[0] = storj.Contract.fromObject(args[0]);
      args[2] = typeof args[1] === 'function' ? args[1] : args[2];
      args[1] = Array.isArray(args[1]) ? args[1] : [];
      break;
    default:
      // noop
  }

  return args;
};

/**
 * Serializes the arguments passed back to the bus
 * @param {String} method - The method name to call
 * @param {Array} argmuments - The arguments passed to the method
 * @returns {Array} args
 */
Renter.prototype._serializeArguments = function(method, args) {
  switch (method) {
    case 'getConsignmentPointer':
      break;
    case 'getRetrievalPointer':
      break;
    case 'getMirrorNodes':
      break;
    case 'getStorageProof':
      break;
    case 'getStorageOffer':
      arg[2] = arg[2].toObject();
    default:
      // noop
  }

  return args;
};

module.exports = Renter;