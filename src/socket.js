const { Server } = require('socket.io');
const { log } = require('./logger');

let io = null;

/**
 * Initialize Socket.io on the given HTTP server.
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' },
    path: '/ws',
  });

  io.on('connection', (socket) => {
    log(`Socket connected: ${socket.id}`);
    socket.on('disconnect', () => {
      log(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

/**
 * Emit an event to all connected clients.
 */
function emit(event, data) {
  if (io) io.emit(event, data);
}

/**
 * Convenience emitters for common events.
 */
const events = {
  tradeUpdate: (trade) => emit('trade:update', trade),
  tradeClosed: (trade) => emit('trade:closed', trade),
  signalDetected: (signal) => emit('signal:detected', signal),
  decisionMade: (decision) => emit('decision:made', decision),
  agentReport: (agentName, report) => emit('agent:report', { agent: agentName, report }),
  positionUpdate: (positions) => emit('positions:update', positions),
  accountUpdate: (account) => emit('account:update', account),
  cycleComplete: (summary) => emit('cycle:complete', summary),
};

module.exports = { initSocket, emit, events };
