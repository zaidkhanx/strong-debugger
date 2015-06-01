var Promise = require('./promise');
var net = require('net');
var inherits = require('util').inherits;
var fork = require('child_process').fork;
var EventEmitter = require('events').EventEmitter;
var newlineJson = require('newline-json');
var debuglog = require('./debuglog');
var Scenario = require('./scenario');
var split = require('split');

exports.debugScript = debugScript;

function debugScript(scriptPath) {
  return new Promise(function(resolve, reject) {
    var runner = require.resolve('./run-in-debugger');
    var child = fork(runner, [scriptPath], { silent: true });
    child.on('error', reject);
    child.on('exit', function(code) {
      reject(new Error('Unexpected exit ' +
        JSON.stringify(Array.prototype.slice.call(arguments))));
    });
    child.on('message', function(msg) {
      if (msg.cmd != 'DEBUGGER_LISTENING') return;
      var port = msg.port;

      var client = new Client(net.connect(port), child)
        .on('ready', function() { resolve(this); })
        .on('error', function(err) { reject(err); });

      child.stdout.pipe(new split().on('data', function(line) {
        debuglog('CHILD STDOUT %s', line);
        client.emit('stdout', line);
      }));
      child.stderr.pipe(new split().on('data', function(line) {
        debuglog('CHILD STDERR %s', line);
        client.emit('stderr', line);
      }));
    });
  }).disposer(function(client) {
    client.close();
  });
}

function Client(conn, debugee) {
  EventEmitter.call(this);

  this._conn = conn;
  this._debugee = debugee;
  this._messagesReceived = [];

  this._setupClientConnection();
  this.on('message', function(msg) {
    this._messagesReceived.push(msg);
  });

  var self = this;
  self._debugee.on('exit', function(code, signal) {
    debuglog('Debugee exited code=%s signal=%s', code, signal);
    if (code) {
      self.emit('error', new Error('Debugee exited with ' + code));
    } else {
      self.emit('child-exit');
    }
  });
}

inherits(Client, EventEmitter);

Client.prototype._setupClientConnection = function() {
  var self = this;
  self._conn.on('error', function(err) {
    debuglog('CONN ERR %s', err);
    self.emit('error', err);
  });

  self._conn.on('connect', function() {
    var reader = new (newlineJson.Parser)();
    reader.on('error', function(err) {
      debuglog('DBG ERR %s', err);
      self.emit('error', err);
    });
    reader.on('data', function(data) {
      debuglog('DBG MSG < %j', data);
      self.emit('message', data);
    });
    self._conn.pipe(reader);

    var writer = new (newlineJson.Stringifier)();
    self.send = function(msg) {
      debuglog('DBG REQ > %j', msg);
      writer.write(msg);
      return Promise.resolve(this);
    };
    writer.pipe(self._conn);

    self.emit('ready');
  });
};

Client.prototype.receive = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    if (self._messagesReceived.length) {
      return resolve(self._messagesReceived.shift());
    }
    self.once('message', function() {
      return resolve(self._messagesReceived.shift());
    });
    self.once('error', reject);
  }).timeout(1000, 'client.receive() timed out after 1s');
};

Client.prototype.close = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    // Allow some time for the client to read
    // any debugger messages waiting in the connection
    setTimeout(function() {
      self._debugee.removeAllListeners();
      self._debugee.once('exit', resolve);
      self._debugee.kill();
    }, 100);
  });
};

Client.prototype.verifyScenario = function(builder) {
  var client = this;
  var scenario = new Scenario();
  return new Promise(function(resolve, reject) {
    builder(scenario);
    resolve(scenario.run(client));
  });
};