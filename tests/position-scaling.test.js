/**
 * Unit tests for the position-scaling decision function. Mocks
 * runtime-config so we control the feature flag + thresholds.
 */

const mockRuntimeConfig = {
  get: jest.fn(() => undefined),
  getAll: jest.fn(() => ({})),
  getEffective: jest.fn(() => ({})),
  set: jest.fn(),
  remove: jest.fn(),
  refresh: jest.fn(),
  init: jest.fn(),
};
jest.mock('../src/runtime-config', () => mockRuntimeConfig);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const scaling = require('../src/position-scaling');

function trade(overrides = {}) {
  return {
    id: 't-1',
    symbol: 'AAPL',
    qty: 100,
    entry_price: 150,
    stop_loss: 145,
    take_profit: 162,
    order_type: 'bracket',
    scale_ins_count: 0,
    last_scale_in_price: null,
    original_qty: 100,
    ...overrides,
  };
}

beforeEach(() => {
  mockRuntimeConfig.get.mockReset().mockImplementation((k) => {
    if (k === 'SCALE_IN_ENABLED') return true;
    return undefined;
  });
});

describe('shouldScaleIn — disabled', () => {
  test('returns false when SCALE_IN_ENABLED is off', () => {
    mockRuntimeConfig.get.mockReturnValue(undefined);
    const r = scaling.shouldScaleIn(trade(), 160, 3.0, 100_000);
    expect(r.scaleIn).toBe(false);
    expect(r.reason).toBe('disabled');
  });
});

describe('shouldScaleIn — basic trigger', () => {
  test('returns true when price exceeds entry + triggerAtr * ATR', () => {
    // Default triggerAtr=1.5, ATR=3 → trigger = 150 + 1*1.5*3 = 154.5
    const r = scaling.shouldScaleIn(trade(), 155, 3.0, 500_000);
    expect(r.scaleIn).toBe(true);
    expect(r.addQty).toBe(50); // 50% of 100
    expect(r.newTotalQty).toBe(150);
    expect(r.newBlendedEntry).toBeGreaterThan(150);
    expect(r.newBlendedEntry).toBeLessThan(155);
  });

  test('returns false when price is below the trigger', () => {
    // trigger = 150 + 1.5*3 = 154.5; price = 153
    const r = scaling.shouldScaleIn(trade(), 153, 3.0, 100_000);
    expect(r.scaleIn).toBe(false);
    expect(r.reason).toBe('below_trigger');
  });
});

describe('shouldScaleIn — stepwise triggering', () => {
  test('second scale-in requires a higher trigger (2× step)', () => {
    // First scale-in already done → scale_ins_count=1
    // Next trigger = entry + 2 * 1.5 * 3 = 150 + 9 = 159
    const t = trade({ scale_ins_count: 1, last_scale_in_price: 155 });
    const below = scaling.shouldScaleIn(t, 158, 3.0, 500_000);
    expect(below.scaleIn).toBe(false);

    const above = scaling.shouldScaleIn(t, 160, 3.0, 500_000);
    expect(above.scaleIn).toBe(true);
    expect(above.scaleInsCount).toBe(2);
  });
});

describe('shouldScaleIn — guards', () => {
  test('rejects when max count reached', () => {
    const t = trade({ scale_ins_count: 2 });
    const r = scaling.shouldScaleIn(t, 200, 3.0, 100_000);
    expect(r.scaleIn).toBe(false);
    expect(r.reason).toBe('max_count_reached');
  });

  test('rejects when order_type is scaled_out (mutual exclusion with partial-exit)', () => {
    const t = trade({ order_type: 'scaled_out' });
    const r = scaling.shouldScaleIn(t, 200, 3.0, 100_000);
    expect(r.scaleIn).toBe(false);
    expect(r.reason).toBe('already_scaled_out');
  });

  test('rejects when current price is at or below the last scale-in price', () => {
    const t = trade({ scale_ins_count: 1, last_scale_in_price: 160 });
    const r = scaling.shouldScaleIn(t, 160, 3.0, 100_000);
    expect(r.scaleIn).toBe(false);
    expect(r.reason).toBe('below_last_scale_in');
  });

  test('rejects when ATR is null or zero', () => {
    expect(scaling.shouldScaleIn(trade(), 200, null, 100_000).reason).toBe('no_atr');
    expect(scaling.shouldScaleIn(trade(), 200, 0, 100_000).reason).toBe('no_atr');
  });
});

describe('shouldScaleIn — position cap', () => {
  test('clamps addQty so combined position stays within MAX_POS_PCT', () => {
    // 100 shares at $150 = $15k. portfolio = $100k, MAX_POS_PCT = 0.10 → cap at $10k.
    // Already over the cap before scale-in → addQty should be 0 → rejected.
    const r = scaling.shouldScaleIn(trade(), 155, 3.0, 100_000);
    // $150 * (100+50) = $23,250 > $10k → gets clamped
    // maxValue = 10000, at $155 → maxQty = floor(10000/155) = 64. Current=100, so 64-100 < 0 → rejected
    expect(r.scaleIn).toBe(false);
    expect(r.reason).toBe('position_cap');
  });

  test('allows scale-in when portfolio is large enough', () => {
    // portfolio = $500k, MAX_POS_PCT = 0.10 → max $50k position
    // 100 shares at $155 = $15.5k + 50 at $155 = $23.25k → well under $50k
    const r = scaling.shouldScaleIn(trade(), 155, 3.0, 500_000);
    expect(r.scaleIn).toBe(true);
    expect(r.newTotalQty).toBe(150);
  });
});

describe('shouldScaleIn — stop management', () => {
  test('moves stop to breakeven on the first scale-in', () => {
    const t = trade({ stop_loss: 145, scale_ins_count: 0 });
    const r = scaling.shouldScaleIn(t, 155, 3.0, 500_000);
    expect(r.scaleIn).toBe(true);
    // breakeven = entry = 150, which is > current stop 145
    expect(r.newStop).toBe(150);
  });

  test('keeps existing stop on subsequent scale-ins (already at breakeven or higher)', () => {
    const t = trade({ stop_loss: 150, scale_ins_count: 1, last_scale_in_price: 155 });
    const r = scaling.shouldScaleIn(t, 160, 3.0, 500_000);
    expect(r.scaleIn).toBe(true);
    expect(r.newStop).toBe(150); // unchanged
  });
});

describe('blended entry', () => {
  test('weighted average of old + new entry prices', () => {
    const r = scaling.shouldScaleIn(trade({ qty: 100, entry_price: 150 }), 160, 3.0, 500_000);
    expect(r.scaleIn).toBe(true);
    // 100*150 + 50*160 = 15000 + 8000 = 23000 / 150 = 153.333...
    expect(r.newBlendedEntry).toBeCloseTo(153.3333, 2);
  });
});

describe('enabled()', () => {
  test('false by default', () => {
    mockRuntimeConfig.get.mockReturnValue(undefined);
    expect(scaling.enabled()).toBe(false);
  });

  test('true when runtime-config returns true', () => {
    mockRuntimeConfig.get.mockImplementation((k) => (k === 'SCALE_IN_ENABLED' ? true : undefined));
    expect(scaling.enabled()).toBe(true);
  });
});
