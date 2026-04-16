/**
 * Sandbox account + position state for replay mode.
 *
 * Pure in-memory ledger that mirrors the small slice of Alpaca state
 * the agency cares about (cash / portfolio_value / buying_power /
 * positions). Replay mode injects this through an Alpaca shim so the
 * real production code path runs unchanged but never touches the
 * Alpaca paper account or the production `trades` table.
 *
 * One sandbox per replay run. Disposable.
 */

class SandboxState {
  constructor({ startingCapital = 100_000, slippagePct = 0.0005, feePerShare = 0, feePerOrder = 0 } = {}) {
    this.cash = startingCapital;
    this.startingCapital = startingCapital;
    this.positions = new Map(); // symbol -> { qty, avgEntry, openedAt, stop, target }
    this.trades = []; // closed trades — full history
    this.equityCurve = []; // [{ timestamp, equity, cash, unrealized }]
    this.signals = []; // every BUY/SELL signal recorded by the agency
    this.decisions = []; // every orchestrator decision
    this.slippagePct = slippagePct;
    this.feePerShare = feePerShare;
    this.feePerOrder = feePerOrder;
  }

  // Slippage helpers — buys fill above clean, sells fill below
  _slippedBuy(price) {
    return price * (1 + this.slippagePct);
  }
  _slippedSell(price) {
    return price * (1 - this.slippagePct);
  }
  _orderCost(qty) {
    return this.feePerOrder + qty * this.feePerShare;
  }

  /**
   * Mirrors alpaca.getAccount() shape so the agency code path doesn't
   * branch on replay-vs-live.
   */
  getAccount() {
    const positionValue = Array.from(this.positions.values()).reduce((sum, p) => sum + p.qty * p.lastPrice, 0);
    return {
      cash: this.cash,
      portfolio_value: this.cash + positionValue,
      buying_power: this.cash, // single-margin paper assumption — no leverage in replay
    };
  }

  /**
   * Mirrors alpaca.getPositions() shape.
   */
  getPositions() {
    return Array.from(this.positions.entries()).map(([symbol, pos]) => ({
      symbol,
      qty: String(pos.qty),
      avg_entry_price: String(pos.avgEntry),
      current_price: String(pos.lastPrice),
      market_value: String(pos.qty * pos.lastPrice),
      unrealized_pl: String(pos.qty * (pos.lastPrice - pos.avgEntry)),
      unrealized_plpc: String((pos.lastPrice - pos.avgEntry) / pos.avgEntry),
      side: 'long',
    }));
  }

  getPosition(symbol) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;
    return this.getPositions().find((p) => p.symbol === symbol);
  }

  /**
   * Open a long position. Records entry slippage + fees and marks the
   * position with stop/target so monitor logic can close it later.
   * Skipped if the symbol already has an open position (mirrors
   * execution-agent's check).
   */
  openLong({ symbol, qty, cleanPrice, stop, target, openedAt, decision = null }) {
    if (this.positions.has(symbol)) {
      return { executed: false, reason: 'position already open' };
    }
    const entryPrice = +this._slippedBuy(cleanPrice).toFixed(4);
    const fees = this._orderCost(qty);
    const cost = qty * entryPrice + fees;
    if (cost > this.cash) {
      return { executed: false, reason: `insufficient cash: need $${cost.toFixed(2)}, have $${this.cash.toFixed(2)}` };
    }
    this.cash -= cost;
    this.positions.set(symbol, {
      qty,
      avgEntry: entryPrice,
      lastPrice: entryPrice,
      stop,
      target,
      openedAt,
      entryFees: fees,
      // For ATR trailing once we add it
      highest: entryPrice,
    });
    this.signals.push({
      ts: openedAt,
      symbol,
      signal: 'BUY',
      price: entryPrice,
      reason: decision?.reasoning?.slice(0, 200) || 'replay buy',
    });
    return { executed: true, symbol, qty, entryPrice, fees };
  }

  /**
   * Close a position at the given clean price, recording exit slippage
   * and fees and writing the closed trade to the trades log.
   */
  closePosition({ symbol, cleanExit, closedAt, exitReason = 'replay_close' }) {
    const pos = this.positions.get(symbol);
    if (!pos) return { executed: false, reason: 'no position' };
    const exitPrice = +this._slippedSell(cleanExit).toFixed(4);
    const exitFees = this._orderCost(pos.qty);
    const grossPnl = (exitPrice - pos.avgEntry) * pos.qty;
    const pnl = grossPnl - exitFees;
    this.cash += pos.qty * exitPrice - exitFees;
    this.trades.push({
      symbol,
      qty: pos.qty,
      entryPrice: pos.avgEntry,
      exitPrice,
      pnl: +pnl.toFixed(2),
      pnlPct: +(((exitPrice - pos.avgEntry) / pos.avgEntry) * 100).toFixed(2),
      fees: +(pos.entryFees + exitFees).toFixed(2),
      exitReason,
      openedAt: pos.openedAt,
      closedAt,
      holdMs: new Date(closedAt) - new Date(pos.openedAt),
    });
    this.signals.push({ ts: closedAt, symbol, signal: 'SELL', price: exitPrice, reason: exitReason });
    this.positions.delete(symbol);
    return { executed: true, symbol, exitPrice, pnl };
  }

  /**
   * Mark each open position to the latest bar close so equity curve
   * + unrealized P&L reflect current value. Called after every cycle.
   */
  markToMarket(prices) {
    for (const [sym, pos] of this.positions) {
      const p = prices[sym];
      if (p != null && p > 0) pos.lastPrice = p;
    }
  }

  /**
   * Snapshot equity at this point in the timeline.
   */
  recordEquity(timestamp) {
    const acct = this.getAccount();
    this.equityCurve.push({
      timestamp,
      equity: +acct.portfolio_value.toFixed(2),
      cash: +acct.cash.toFixed(2),
      unrealized: +(acct.portfolio_value - acct.cash).toFixed(2),
    });
  }

  /**
   * Final summary block for the replay report.
   */
  summary() {
    const wins = this.trades.filter((t) => t.pnl > 0);
    const losses = this.trades.filter((t) => t.pnl <= 0);
    const totalPnl = this.trades.reduce((s, t) => s + t.pnl, 0);
    const totalFees = this.trades.reduce((s, t) => s + (t.fees || 0), 0);
    const winRate = this.trades.length ? (wins.length / this.trades.length) * 100 : 0;
    const finalEquity = this.equityCurve[this.equityCurve.length - 1]?.equity ?? this.cash;
    let peak = this.startingCapital,
      maxDd = 0;
    for (const e of this.equityCurve) {
      if (e.equity > peak) peak = e.equity;
      const dd = peak > 0 ? ((peak - e.equity) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
    }
    return {
      startingCapital: this.startingCapital,
      finalEquity: +finalEquity.toFixed(2),
      totalReturn: +(((finalEquity - this.startingCapital) / this.startingCapital) * 100).toFixed(2),
      totalPnl: +totalPnl.toFixed(2),
      totalFees: +totalFees.toFixed(2),
      totalTrades: this.trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: +winRate.toFixed(1),
      maxDrawdown: +maxDd.toFixed(2),
      stillOpen: this.positions.size,
    };
  }
}

module.exports = { SandboxState };
