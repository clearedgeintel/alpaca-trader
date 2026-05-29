const haltTracker = require('../src/halt-tracker');

beforeEach(() => haltTracker.reset());

describe('halt-tracker', () => {
  test('applies a halt event and marks symbol halted', () => {
    const result = haltTracker.applyStatusEvent({
      S: 'AAPL',
      sc: 'H',
      sm: 'Trading halt - other',
      t: '2026-05-28T14:00:00Z',
    });
    expect(result).toMatchObject({ symbol: 'AAPL', halted: true, transition: 'halted' });
    expect(haltTracker.isHalted('AAPL')).toBe(true);
  });

  test('applies a resume event and clears halted state', () => {
    haltTracker.applyStatusEvent({ S: 'TSLA', sc: 'H' });
    expect(haltTracker.isHalted('TSLA')).toBe(true);
    const resumeResult = haltTracker.applyStatusEvent({ S: 'TSLA', sc: 'T', sm: 'Trading resumption' });
    expect(resumeResult).toMatchObject({ symbol: 'TSLA', halted: false, transition: 'resumed' });
    expect(haltTracker.isHalted('TSLA')).toBe(false);
  });

  test('handles all documented halt codes', () => {
    const codes = ['B', 'C', 'D', 'E', 'H', 'J', 'K', 'M', 'P'];
    for (const code of codes) {
      haltTracker.applyStatusEvent({ S: `SYM_${code}`, sc: code });
      expect(haltTracker.isHalted(`SYM_${code}`)).toBe(true);
    }
  });

  test('handles all documented resume codes', () => {
    const codes = ['Q', 'R', 'T', 'O'];
    for (const code of codes) {
      // Halt first, then resume
      haltTracker.applyStatusEvent({ S: `SYM_${code}`, sc: 'H' });
      expect(haltTracker.isHalted(`SYM_${code}`)).toBe(true);
      haltTracker.applyStatusEvent({ S: `SYM_${code}`, sc: code });
      expect(haltTracker.isHalted(`SYM_${code}`)).toBe(false);
    }
  });

  test('unknown status code defaults to NOT halted on first-seen', () => {
    const result = haltTracker.applyStatusEvent({ S: 'NEW', sc: 'Z', sm: 'Unknown' });
    expect(result.transition).toBe('unknown');
    expect(haltTracker.isHalted('NEW')).toBe(false);
  });

  test('unknown status code preserves prior halted state', () => {
    haltTracker.applyStatusEvent({ S: 'XXX', sc: 'H' });
    expect(haltTracker.isHalted('XXX')).toBe(true);
    haltTracker.applyStatusEvent({ S: 'XXX', sc: 'Z', sm: 'unknown' });
    // Unknown code should NOT silently resume — prior state preserved
    expect(haltTracker.isHalted('XXX')).toBe(true);
  });

  test('case-insensitive symbol matching', () => {
    haltTracker.applyStatusEvent({ S: 'aapl', sc: 'H' });
    expect(haltTracker.isHalted('AAPL')).toBe(true);
    expect(haltTracker.isHalted(' aapl ')).toBe(true);
  });

  test('repeated halt events do not change "since" timestamp', () => {
    haltTracker.applyStatusEvent({ S: 'MSFT', sc: 'H' });
    const since1 = haltTracker.getStatus('MSFT').since;
    // wait a tick
    return new Promise((resolve) => setTimeout(() => {
      haltTracker.applyStatusEvent({ S: 'MSFT', sc: 'H' }); // same status repeated
      const since2 = haltTracker.getStatus('MSFT').since;
      expect(since2).toEqual(since1); // unchanged
      resolve();
    }, 10));
  });

  test('getHaltedSymbols returns all currently halted', () => {
    haltTracker.applyStatusEvent({ S: 'A', sc: 'H' });
    haltTracker.applyStatusEvent({ S: 'B', sc: 'J' }); // LULD
    haltTracker.applyStatusEvent({ S: 'C', sc: 'H' });
    haltTracker.applyStatusEvent({ S: 'C', sc: 'T' }); // C resumes
    const halted = haltTracker.getHaltedSymbols();
    const syms = halted.map((h) => h.symbol).sort();
    expect(syms).toEqual(['A', 'B']);
  });

  test('handles missing/empty symbol gracefully', () => {
    expect(haltTracker.applyStatusEvent({ sc: 'H' })).toBeNull();
    expect(haltTracker.applyStatusEvent(null)).toBeNull();
    expect(haltTracker.applyStatusEvent({})).toBeNull();
  });

  test('isHalted defaults to false for symbols never seen', () => {
    expect(haltTracker.isHalted('NEVER_SEEN')).toBe(false);
  });

  test('reset clears all state', () => {
    haltTracker.applyStatusEvent({ S: 'AAPL', sc: 'H' });
    expect(haltTracker.isHalted('AAPL')).toBe(true);
    haltTracker.reset();
    expect(haltTracker.isHalted('AAPL')).toBe(false);
    expect(haltTracker.getHaltedSymbols()).toEqual([]);
  });
});
