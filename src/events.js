'use strict';

// Process-wide event bus for pushing live updates to SSE clients.
// Emitters: repository (step, cycle), scheduler (scheduler).
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // many SSE clients may subscribe

module.exports = bus;
