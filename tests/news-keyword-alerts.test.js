const { detectCriticalAlerts } = require('../src/agents/news-keyword-alerts');

const article = (headline, symbols, summary = '') => ({
  headline,
  summary,
  symbols,
});

describe('detectCriticalAlerts', () => {
  test('catches earnings miss', () => {
    const alerts = detectCriticalAlerts(
      [article('AAPL Misses Earnings Expectations in Q3', ['AAPL'])],
      ['AAPL', 'MSFT'],
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ symbol: 'AAPL', type: 'earnings_miss', impact: 'very_bearish' });
  });

  test('catches FDA rejection', () => {
    const alerts = detectCriticalAlerts(
      [article('FDA Denies Approval for MRNA Drug Candidate', ['MRNA'])],
      ['MRNA'],
    );
    expect(alerts[0]).toMatchObject({ symbol: 'MRNA', impact: 'very_bearish', type: 'fda_reject' });
  });

  test('catches Hindenburg short report', () => {
    const alerts = detectCriticalAlerts(
      [article('Hindenburg Research Targets NKLA Over Fraud Allegations', ['NKLA'])],
      ['NKLA'],
    );
    expect(alerts[0]).toMatchObject({ symbol: 'NKLA', impact: 'very_bearish' });
    // Could match either short_report or fraud_or_probe — first hit wins
    expect(['short_report', 'fraud_or_probe']).toContain(alerts[0].type);
  });

  test('catches bullish FDA approval', () => {
    const alerts = detectCriticalAlerts(
      [article('FDA Approves PFE New Drug for Heart Disease', ['PFE'])],
      ['PFE'],
    );
    expect(alerts[0]).toMatchObject({ symbol: 'PFE', impact: 'very_bullish', type: 'fda_approve' });
  });

  test('catches earnings beat + guidance raise (first bullish hit wins)', () => {
    const alerts = detectCriticalAlerts(
      [article('TSLA Beats Earnings and Raises Full-Year Guidance', ['TSLA'])],
      ['TSLA'],
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ symbol: 'TSLA', impact: 'very_bullish' });
  });

  test('emits BOTH directions when an article carries both', () => {
    const alerts = detectCriticalAlerts(
      [
        article(
          'XYZ Beats Earnings But SEC Probe Casts Shadow',
          ['XYZ'],
          'Strong quarter overshadowed by SEC investigation announced today.',
        ),
      ],
      ['XYZ'],
    );
    const impacts = alerts.map((a) => a.impact).sort();
    expect(impacts).toEqual(['very_bearish', 'very_bullish']);
  });

  test('ignores articles for symbols not in watchlist', () => {
    const alerts = detectCriticalAlerts(
      [article('AAPL Misses Earnings', ['AAPL'])],
      ['TSLA', 'NVDA'],
    );
    expect(alerts).toHaveLength(0);
  });

  test('ignores articles where the article does NOT tag the symbol', () => {
    // A mega-cap mention in the body shouldn't trigger an alert on that
    // symbol — symbol attribution requires explicit tagging.
    const alerts = detectCriticalAlerts(
      [
        article(
          'Tech Sector Slumps After Earnings Miss Wave',
          ['SPY'],
          'Several names including AAPL and MSFT dragged the sector lower.',
        ),
      ],
      ['SPY', 'AAPL', 'MSFT'],
    );
    expect(alerts.every((a) => a.symbol === 'SPY')).toBe(true);
    expect(alerts.find((a) => a.symbol === 'AAPL')).toBeUndefined();
  });

  test('dedupes the same (symbol, type) across multiple articles', () => {
    // Polygon + Alpaca often carry the same story; alerts should
    // collapse to one per (symbol, type).
    const alerts = detectCriticalAlerts(
      [
        article('AAPL Misses Earnings on Q3 Report', ['AAPL']),
        article('AAPL Earnings Miss Surprises Analysts', ['AAPL']),
      ],
      ['AAPL'],
    );
    expect(alerts).toHaveLength(1);
  });

  test('handles bankruptcy filing', () => {
    const alerts = detectCriticalAlerts(
      [article('XYZ Corp Files for Chapter 11 Bankruptcy', ['XYZ'])],
      ['XYZ'],
    );
    expect(alerts[0]).toMatchObject({ symbol: 'XYZ', type: 'bankruptcy', impact: 'very_bearish' });
  });

  test('handles CEO resignation', () => {
    const alerts = detectCriticalAlerts(
      [article('TWTR CEO Resigns Amid Mounting Pressure', ['TWTR'])],
      ['TWTR'],
    );
    expect(alerts[0]).toMatchObject({ symbol: 'TWTR', type: 'executive_exit', impact: 'very_bearish' });
  });

  test('handles acquisition announcement (bullish for target)', () => {
    const alerts = detectCriticalAlerts(
      [article('MSFT to Acquire ATVI in $69B Deal', ['ATVI', 'MSFT'])],
      ['ATVI', 'MSFT'],
    );
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].impact).toBe('very_bullish');
  });

  test('returns empty on empty inputs', () => {
    expect(detectCriticalAlerts([], ['AAPL'])).toEqual([]);
    expect(detectCriticalAlerts(null, ['AAPL'])).toEqual([]);
    expect(detectCriticalAlerts([article('Generic Market News', ['AAPL'])], ['AAPL'])).toEqual([]);
  });

  test('does NOT trigger on partial matches', () => {
    // "missed" should not match "missing" without earnings context
    const alerts = detectCriticalAlerts(
      [article('AAPL: Where Did the Magic Go? Investors Missing the Steve Jobs Era', ['AAPL'])],
      ['AAPL'],
    );
    expect(alerts).toEqual([]);
  });
});
