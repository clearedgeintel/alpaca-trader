const EventEmitter = require('events');
const crypto = require('crypto');
const { log } = require('../logger');
const db = require('../db');

const MESSAGE_TYPES = ['SIGNAL', 'ALERT', 'VETO', 'REPORT', 'DECISION'];

class MessageBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
    this._history = [];
    this._maxHistory = 500;
  }

  // Publish a typed message from an agent
  async publish(type, from, payload) {
    if (!MESSAGE_TYPES.includes(type)) {
      throw new Error(`Invalid message type: ${type}. Must be one of: ${MESSAGE_TYPES.join(', ')}`);
    }

    const message = {
      id: crypto.randomUUID(),
      type,
      from,
      payload,
      timestamp: new Date().toISOString(),
    };

    this._history.push(message);
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory);
    }

    log(`MessageBus: [${type}] from ${from}`, {
      symbol: payload.symbol || null,
      signal: payload.signal || null,
    });

    // Emit both the specific type and a wildcard
    this.emit(type, message);
    this.emit('message', message);

    // Persist to DB (fire-and-forget, don't block the bus)
    this._persist(message).catch(() => {});

    return message;
  }

  // Subscribe to a specific message type
  subscribe(type, handler) {
    this.on(type, handler);
    return () => this.off(type, handler);
  }

  // Subscribe to all messages
  subscribeAll(handler) {
    this.on('message', handler);
    return () => this.off('message', handler);
  }

  // Get recent messages, optionally filtered
  getHistory(filter = {}) {
    let messages = this._history;

    if (filter.type) {
      messages = messages.filter(m => m.type === filter.type);
    }
    if (filter.from) {
      messages = messages.filter(m => m.from === filter.from);
    }
    if (filter.symbol) {
      messages = messages.filter(m => m.payload?.symbol === filter.symbol);
    }
    if (filter.limit) {
      messages = messages.slice(-filter.limit);
    }

    return messages;
  }

  async _persist(message) {
    try {
      await db.query(
        `INSERT INTO agent_messages (id, type, from_agent, payload, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [message.id, message.type, message.from, JSON.stringify(message.payload), message.timestamp]
      );
    } catch {
      // Non-critical — message bus works without DB persistence
    }
  }
}

// Singleton instance
const messageBus = new MessageBus();

module.exports = { messageBus, MESSAGE_TYPES };
