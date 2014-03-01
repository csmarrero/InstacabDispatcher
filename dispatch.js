var async = require('async'),
	util = require('util'),
	_ = require('underscore'),
	inspect = require('util').inspect,
	apiBackend = require('./backend'),
	Trip = require("./models/trip").Trip,
	tripRepository = require('./models/trip').repository,
	driverRepository = require('./models/driver').repository,
	clientRepository = require('./models/client').repository,
	Driver = require("./models/driver").Driver,
	Client = require("./models/client").Client,
	subscriber = require("redis").createClient(),
	MessageFactory = require("./messageFactory");

function Dispatcher() {
	this.driverEventCallback = this._clientsUpdateNearbyDrivers.bind(this);
	this.channelClients = {};
	
	subscriber.subscribe('channel:drivers');
	subscriber.subscribe('channel:clients');
	subscriber.subscribe('channel:trips');

	// Broadcast message to clients
	subscriber.on('message', function(channel, message) {
		channel = channel.split(':')[1];
		if (!this.channelClients[channel]) return;

		this.channelClients[channel].forEach(function(connection){
			data = JSON.stringify({channel: channel, data: JSON.parse(message)});
			
			try {
				// console.log('Broadcast: ' + data);
				connection.send(data);				
			}
			catch(e) {};
		}, this);

	}.bind(this));	
}

Dispatcher.prototype = {
	Login: function(context, callback) {
		async.waterfall([
			function(nextFn) {
				apiBackend.loginClient(context.message.email, context.message.password, nextFn);
			},
			function(client, nextFn) {
				client.login(context, nextFn);
			}
		], callback);
	},

	SignUpClient: function(context, callback) {
		async.waterfall([
			function(nextFn) {
				apiBackend.signupClient(context.message, nextFn);
			},
			function(client, nextFn) {
				client.login(context, nextFn);
			}
		], callback);
	},
	
	LogoutClient: function(context, callback) {
		async.waterfall([
			clientRepository.get.bind(clientRepository, context.message.id),

			function(client, nextFn) {
				client.logout(context, nextFn);
			}
		], callback);
	},

	PingClient: function(context, callback) {
		async.waterfall([
			clientRepository.get.bind(clientRepository, context.message.id),

			function(client, nextFn) {
				client.ping(context, nextFn);
			}
		], callback);
	},

	Pickup: function(context, callback) {
		if (!Client.canRequestToLocation(context.message.pickupLocation))
			return callback(null, MessageFactory.createError("К сожалению мы еще не работаем в вашем регионе. Но мы постоянно расширяем наш сервис, следите за обновлениями вступив в группу http://vk.com/instacab"));

		async.waterfall([
			// Find client
			clientRepository.get.bind(clientRepository, context.message.id),
			// Find available driver
			function(client, next) {
				Driver.findOneAvailableNearPickupLocation(context.message.pickupLocation, function(err, driver){
					next(err, client, driver);
				});
			},
			// Create trip
			function(client, driver, next) {
				Trip.create(client, driver, next);
			},
			// Dispatch
			function(trip, next) {
				trip.pickup(context, next);
			}
		], callback);
	},
	
	// Client canceled pickup request while we were searching/waiting for drivers
	CancelPickup: function(context, callback) {
		tripRepository.get(context.message.tripId, function(err, trip){
			if (err) return callback(err);

			trip.clientCancelPickup(context, callback);
		});
	},

	// Client canceled trip after driver was dispatched and before trip start
	CancelTripClient: function(context, callback) {
		tripRepository.get(context.message.tripId, function(err, trip){
			if (err) return callback(err);

			trip.clientCancel(context, callback);
		});
	},

	RatingDriver: function(context, callback) {
		tripRepository.get(context.message.tripId, function(err, trip){
			if (err) return callback(err);

			trip.clientRateDriver(context, callback);
		});
	},

	LoginDriver: function(context, callback) {
		async.waterfall([
			function(nextFn) {
				apiBackend.loginDriver(context.message.email, context.message.password, nextFn);
			},
			function(driver, nextFn) {
				this._subscribeToDriverEvents(driver);

				driver.login(context, nextFn);
			}.bind(this),
		], callback);
	},

	LogoutDriver: function(context, callback) {
		driverRepository.get(context.message.id, function(err, driver) {
			if (err) return callback(err, null);

			driver.logout(context, callback);
		});
	},

	OffDutyDriver: function(context, callback) {
		driverRepository.get(context.message.id, function(err, driver) {
			if (err) return callback(err, null);

			driver.offDuty(context, callback);
		});
	},

	OnDutyDriver: function(context, callback) {
		driverRepository.get(context.message.id, function(err, driver) {
			if (err) return callback(err, null);

			driver.onDuty(context, callback);
		});
	},

	PingDriver: function(context, callback) {
		driverRepository.get(context.message.id, function(err, driver) {
			if (err) return callback(err);

			driver.ping(context, callback);
		});
	},

	ConfirmPickup: function(context, callback) {
		tripRepository.get(context.message.tripId, function(err, trip){
			if (err) return callback(err);

			trip.confirm(context, callback);
		});
	},

	ArrivingNow: function(context, callback) {
		tripRepository.get(context.message.tripId, function(err, trip){
			if (err) return callback(err);

			trip.driverArriving(context, callback);
		});
	},

	BeginTripDriver: function(context, callback) {
		tripRepository.get(context.message.tripId, function(err, trip){
			if (err) return callback(err);

			trip.driverBegin(context, callback);
		});
	},

	CancelTripDriver: function(context, callback) {
		tripRepository.get(context.message.tripId, function(err, trip){
			if (err) return callback(err);

			trip.driverCancel(context, callback);
		});
	},
	
	EndTrip: function(context, callback) {
		tripRepository.get(context.message.tripId, function(err, trip) {
			if (err) return callback(err);

			trip.driverEnd(context, callback);
		});
	},

	ListVehicles: function(context, callback) {
		driverRepository.get(context.message.id, function(err, driver) {
			if (err) return callback(err);

			console.log("+ ListVehicles");
			console.log(util.inspect(driver, {colors: true}));
			driver.listVehicles(callback);
		});
	},

	SelectVehicle: function(context, callback) {
		driverRepository.get(context.message.id, function(err, driver) {
			if (err) return callback(err);

			driver.selectVehicle(context, callback);
		});
	},

	RatingClient: function(context, callback) {
		tripRepository.get(context.message.tripId, function(err, trip){
			if (err) return callback(err);

			trip.driverRateClient(context, callback);
		});
	},

	ApiCommand: function(context, callback) {
		apiBackend.apiCommand(context.message, callback);
	},

	Subscribe: function(context, callback) {
		if (!context.message.channel) return callback(new Error('channel could not be empty'));

		// Client subscriptions management
		this.channelClients[context.message.channel] = this.channelClients[context.message.channel] || [];
		var clients = this.channelClients[context.message.channel];
		clients.push(context.connection);

		console.log("Subscribe to " + context.message.channel);
		console.log("Channel " + context.message.channel + " has " + clients.length + " subscribers");
		
		// Remove disconnected clients
		context.connection.once('close', function() {
			index = clients.indexOf(context.connection);
			if (index > -1) {
				console.log('Remove subscriber from ' + context.message.channel);
				clients.splice(index, 1);
			}
		});

		// Push initial state
		if (context.message.channel === 'drivers') {
			Driver.publishAll();
		} else if (context.message.channel === 'clients') {
			Client.publishAll();
		} else if (context.message.channel === 'trips') {
			Trip.publishAll();
		}		
	}
}

function responseWithError(text){
	console.log(text);
	this.send(JSON.stringify(MessageFactory.createError(text)));
}

Dispatcher.prototype._parseJSONData = function(data, connection) {
	var message;
	try {
	  message = JSON.parse(data);
	  console.log(util.inspect(message, {depth: 3, colors: true}));
	}
	catch(e) {
	  console.log(e);
	  responseWithError.call(connection, e.message);
	}

	return message;
}

Dispatcher.prototype._findMessageHandler = function(message, connection) {
	if (message.app !== 'client' && message.app !== 'driver' && message.app !== 'god') {
		return responseWithError.call(connection, 'Unknown client app: ' + message.app);
	}

	var handler = this.__proto__[message.messageType];
	if (!handler) {
		return responseWithError.call(connection, 'Unsupported message type: ' + message.messageType);
	}

	return handler;
}

// Update all clients except the one requested pickup
Dispatcher.prototype._clientsUpdateNearbyDrivers = function(driver, clientRequestedPickup) {
	var skipClientId = clientRequestedPickup ? clientRequestedPickup.id : null;

	clientRepository.each(function(client) {
		if (client.id === skipClientId) return;

		client.updateNearbyDrivers(function(err){
			if (err) console.log(err);
		});
	});
}

// Subscribe to driver events (1 time)
Dispatcher.prototype._subscribeToDriverEvents = function(driver) {
	_.each(['connect', 'disconnect', 'available', 'unavailable'], function(eventName){
		driver.removeListener(eventName, this.driverEventCallback);
		driver.on(eventName, this.driverEventCallback);
	}.bind(this));
}

Dispatcher.prototype.load = function(callback) {
	var self = this;
	async.parallel({
		drivers: driverRepository.all.bind(driverRepository),
		clients: clientRepository.all.bind(clientRepository),
		trips: tripRepository.all.bind(tripRepository)
	},
	function(err, result){
		async.parallel([
			function(next) {
				console.log('Loaded ' + result.drivers.length + ' driver(s)');
				async.each(result.drivers, function(driver, cb){
					self._subscribeToDriverEvents(driver);
					driver.load(cb);
				}, next);
			},
			function(next) {
				console.log('Loaded ' + result.clients.length + ' client(s)');
				async.each(result.clients, function(client, cb){
					client.load(cb);
				}, next);
			},
			function(next) {
				console.log('Loaded ' + result.trips.length + ' trip(s)');
				async.each(result.trips, function(trip, cb){
					trip.load(function(err) {
						if (err) console.log('Error loading trip ' + trip.id + ':' + err);
						cb()
					});
				}, next);
			}

		], callback);
	});
}

Dispatcher.prototype.processMessage = function(data, connection) {
	console.log("Process message");

	var message;
	if (!(message = this._parseJSONData(data, connection))) return;

	// Find message handler
	var messageHandler;
	if (!(messageHandler = this._findMessageHandler(message, connection))) return;

	// Validate token
	// TODO: Сделать посылку RPC обработчики только для Driver & Client, 
	// а они в свою очередь будут делегировать работу Trip.
	// Тогда просто будет проверять token

	// Handle message
	// returns: RPC response message
	messageHandler.call(this, {message: message, connection: connection}, function(err, result) {
		if(err) {
			console.log(err.stack);
			return responseWithError.call(connection, err.message);
		}

		console.log('Sending response');
		console.log(util.inspect(result, {depth: 3, colors: true}));

		// Send response
		connection.send(JSON.stringify(result), function(err) {
			if (err) return console.log(err);
		});
	});
}

module.exports = Dispatcher;