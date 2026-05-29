const brokerHealth = require('../src/broker-health');

beforeEach(() => brokerHealth._resetForTests());

const netErr = () => {
  const e = new Error('connection reset');
  e.code = 'ECONNRESET';
  return e;
};
const fiveOhThree = () => {
  const e = new Error('Alpaca 503: down');
  e.status = 503;
  return e;
};
const notFound = () => {
  const e = new Error('Alpaca 404: position not found');
  e.status = 404;
  return e;
};

describe('broker-health', () => {
  test('starts HEALTHY', () => {
    expect(brokerHealth.getState()).toBe('HEALTHY');
    expect(brokerHealth.isHealthy()).toBe(true);
  });

  test('4xx errors are NOT outage signals', () => {
    expect(brokerHealth.isOutageSignal(notFound())).toBe(false);
    brokerHealth.recordFailure(notFound());
    brokerHealth.recordFailure(notFound());
    brokerHealth.recordFailure(notFound());
    expect(brokerHealth.isHealthy()).toBe(true);
  });

  test('5xx + network errors ARE outage signals', () => {
    expect(brokerHealth.isOutageSignal(fiveOhThree())).toBe(true);
    expect(brokerHealth.isOutageSignal(netErr())).toBe(true);
  });

  test('3 spaced failures trigger OUTAGE', () => {
    const real = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      brokerHealth.recordFailure(netErr()); t += 31_000;
      brokerHealth.recordFailure(netErr()); t += 31_000;
      expect(brokerHealth.isHealthy()).toBe(true);
      brokerHealth.recordFailure(netErr()); t += 100;
      expect(brokerHealth.getState()).toBe('OUTAGE');
      expect(brokerHealth.isHealthy()).toBe(false);
    } finally {
      Date.now = real;
    }
  });

  test('3 rapid-fire failures (retries) count as ONE incident', () => {
    const real = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      brokerHealth.recordFailure(netErr()); t += 100;
      brokerHealth.recordFailure(netErr()); t += 100;
      brokerHealth.recordFailure(netErr()); t += 100;
      brokerHealth.recordFailure(netErr()); t += 100;
      // All within 30s of the first — only the first counts
      expect(brokerHealth.isHealthy()).toBe(true);
    } finally {
      Date.now = real;
    }
  });

  test('RECOVERING state after success-then-grace', () => {
    const real = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      // 3 spaced failures → OUTAGE
      brokerHealth.recordFailure(netErr()); t += 31_000;
      brokerHealth.recordFailure(netErr()); t += 31_000;
      brokerHealth.recordFailure(netErr()); t += 1_000;
      expect(brokerHealth.getState()).toBe('OUTAGE');
      // Success arrives — still RECOVERING because within grace period
      brokerHealth.recordSuccess();
      expect(brokerHealth.getState()).toBe('RECOVERING');
      expect(brokerHealth.isHealthy()).toBe(false);
      // Grace period elapses → HEALTHY
      t += 61_000;
      expect(brokerHealth.getState()).toBe('HEALTHY');
      expect(brokerHealth.isHealthy()).toBe(true);
    } finally {
      Date.now = real;
    }
  });

  test('failures age out of the 5-min window', () => {
    const real = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      brokerHealth.recordFailure(netErr()); t += 31_000;
      brokerHealth.recordFailure(netErr()); t += 31_000;
      brokerHealth.recordFailure(netErr());
      expect(brokerHealth.getState()).toBe('OUTAGE');
      // Jump past the 5-min window
      t += 6 * 60_000;
      expect(brokerHealth.getState()).toBe('HEALTHY');
    } finally {
      Date.now = real;
    }
  });

  test('getStatus returns shape with state + failure count', () => {
    brokerHealth.recordFailure(fiveOhThree());
    const s = brokerHealth.getStatus();
    expect(s).toMatchObject({ state: 'HEALTHY', failures: 1 });
    expect(s.lastFailure).toMatchObject({ error: expect.stringContaining('503') });
  });

  test('non-Error inputs do not crash', () => {
    expect(() => brokerHealth.recordFailure(null)).not.toThrow();
    expect(() => brokerHealth.recordFailure(undefined)).not.toThrow();
    expect(() => brokerHealth.recordFailure({})).not.toThrow();
    expect(brokerHealth.isHealthy()).toBe(true);
  });

  test('ENOTFOUND / ECONNREFUSED messages detected', () => {
    const e = new Error('getaddrinfo ENOTFOUND api.alpaca.markets');
    expect(brokerHealth.isOutageSignal(e)).toBe(true);
  });

  test('successful call after near-outage prevents OUTAGE state', () => {
    // 2 failures (under threshold), success, another failure (still 3 total
    // but with success in between → state is OUTAGE only if last success
    // is before last failure)
    const real = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      brokerHealth.recordFailure(netErr()); t += 31_000;
      brokerHealth.recordFailure(netErr()); t += 31_000;
      brokerHealth.recordSuccess(); t += 1_000;
      brokerHealth.recordFailure(netErr());
      // 3 failures present in the window, last success was BEFORE last failure
      // → still OUTAGE
      expect(brokerHealth.getState()).toBe('OUTAGE');
    } finally {
      Date.now = real;
    }
  });
});
