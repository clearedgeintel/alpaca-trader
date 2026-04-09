const { log, error } = require('./logger');

// Reddit public JSON API — no auth required for reading
const REDDIT_BASE = 'https://www.reddit.com';

// Subreddits most relevant to stock trading
const TRADING_SUBREDDITS = ['wallstreetbets', 'stocks', 'investing', 'options'];

/**
 * Fetch recent posts mentioning a symbol from trading subreddits.
 * Uses Reddit's public JSON API (no OAuth needed).
 *
 * @param {string} symbol - Stock symbol to search for
 * @param {number} [limit=10] - Max posts to return
 * @returns {Promise<Array<{title, score, comments, subreddit, created, url}>>}
 */
async function getRedditMentions(symbol, limit = 10) {
  try {
    // Search across trading subreddits
    const subreddits = TRADING_SUBREDDITS.join('+');
    const url = `${REDDIT_BASE}/r/${subreddits}/search.json?q=${encodeURIComponent(symbol)}&sort=new&t=day&limit=${limit}&restrict_sr=on`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'alpaca-trader-bot/2.0' },
    });

    if (!res.ok) {
      if (res.status === 429) {
        log('Reddit rate limited, skipping');
        return [];
      }
      throw new Error(`Reddit ${res.status}`);
    }

    const data = await res.json();
    const posts = (data?.data?.children || []).map(child => {
      const p = child.data;
      return {
        title: p.title,
        score: p.score,
        comments: p.num_comments,
        subreddit: p.subreddit,
        created: new Date(p.created_utc * 1000).toISOString(),
        url: `https://reddit.com${p.permalink}`,
        upvoteRatio: p.upvote_ratio,
        flair: p.link_flair_text || null,
      };
    });

    return posts;
  } catch (err) {
    error(`Reddit fetch failed for ${symbol}`, err);
    return [];
  }
}

/**
 * Get aggregated Reddit buzz metrics for multiple symbols.
 * Returns mention counts, average scores, and sentiment signals.
 *
 * @param {string[]} symbols
 * @returns {Promise<Object>} { symbolBuzz: { AAPL: { mentions, avgScore, ... } }, topPosts: [] }
 */
async function getRedditBuzz(symbols) {
  const symbolBuzz = {};
  const topPosts = [];

  // Fetch in parallel with small batches to avoid rate limiting
  const BATCH_SIZE = 3;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(sym => getRedditMentions(sym, 5))
    );

    for (let j = 0; j < batch.length; j++) {
      const sym = batch[j];
      if (results[j].status === 'fulfilled') {
        const posts = results[j].value;
        const totalScore = posts.reduce((s, p) => s + p.score, 0);
        const totalComments = posts.reduce((s, p) => s + p.comments, 0);

        symbolBuzz[sym] = {
          mentions: posts.length,
          totalScore,
          avgScore: posts.length > 0 ? Math.round(totalScore / posts.length) : 0,
          totalComments,
          avgUpvoteRatio: posts.length > 0
            ? +(posts.reduce((s, p) => s + (p.upvoteRatio || 0.5), 0) / posts.length).toFixed(2)
            : 0.5,
          // High engagement = potential momentum signal
          buzzLevel: totalComments > 50 || totalScore > 200 ? 'high' :
                     totalComments > 20 || totalScore > 50 ? 'medium' : 'low',
        };

        // Collect high-engagement posts
        for (const post of posts) {
          if (post.score > 50 || post.comments > 20) {
            topPosts.push({ ...post, symbol: sym });
          }
        }
      } else {
        symbolBuzz[sym] = { mentions: 0, totalScore: 0, avgScore: 0, totalComments: 0, avgUpvoteRatio: 0.5, buzzLevel: 'none' };
      }
    }

    // Brief pause between batches to respect rate limits
    if (i + BATCH_SIZE < symbols.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Sort top posts by engagement
  topPosts.sort((a, b) => (b.score + b.comments * 2) - (a.score + a.comments * 2));

  return { symbolBuzz, topPosts: topPosts.slice(0, 10) };
}

module.exports = { getRedditMentions, getRedditBuzz };
