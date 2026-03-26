const express = require('express');
const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const { log, error } = require('./logger');

const app = express();
let lastScanTime = null;

function setLastScanTime(time) {
  lastScanTime = time;
}

// Middleware
app.use(express.json());

// Health / status
app.get('/api/status', (req, res) => {
  const { DateTime } = require('luxon');
  const now = DateTime.now().setZone('America/New_York');
  const day = now.weekday; // 1=Mon, 7=Sun
  const isWeekday = day >= 1 && day <= 5;
  const minutes = now.hour * 60 + now.minute;
  const openMin = config.MARKET_OPEN_HOUR * 60 + config.MARKET_OPEN_MIN;
  const closeMin = config.MARKET_CLOSE_HOUR * 60 + config.MARKET_CLOSE_MIN;
  const marketOpen = isWeekday && minutes >= openMin && minutes <= closeMin;

  res.json({
    success: true,
    data: {
      status: 'running',
      market_open: marketOpen,
      last_scan: lastScanTime,
      uptime_seconds: Math.floor(process.uptime()),
    },
  });
});

// Live account from Alpaca
app.get('/api/account', async (req, res) => {
  try {
    const data = await alpaca.getAccount();
    res.json({ success: true, data });
  } catch (err) {
    error('API /account failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Live positions from Alpaca
app.get('/api/positions', async (req, res) => {
  try {
    const data = await alpaca.getPositions();
    res.json({ success: true, data });
  } catch (err) {
    error('API /positions failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trades from DB
app.get('/api/trades', async (req, res) => {
  try {
    const { status } = req.query;
    let result;
    if (status) {
      result = await db.query(
        'SELECT * FROM trades WHERE status = $1 ORDER BY created_at DESC',
        [status]
      );
    } else {
      result = await db.query('SELECT * FROM trades ORDER BY created_at DESC');
    }
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /trades failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single trade
app.get('/api/trades/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM trades WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Trade not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    error('API /trades/:id failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Signals from DB
app.get('/api/signals', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await db.query(
      'SELECT * FROM signals ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /signals failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Daily performance
app.get('/api/performance', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM daily_performance ORDER BY trade_date DESC'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /performance failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function start() {
  app.listen(config.PORT, () => {
    log(`API server running on port ${config.PORT}`);
  });
}

module.exports = { start, setLastScanTime };
