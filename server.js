require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db, uniqueReferralCode } = require('./db');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Secret used to sign login session tokens (JWTs). Set JWT_SECRET in your
// .env for real use - without it we generate a random one on every
// restart, which means everyone gets logged out each time the server
// restarts (fine for testing, not for production).
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set in .env - using a temporary random secret. Everyone will be logged out whenever this server restarts. Set JWT_SECRET for real use.');
}

// The one and only account allowed to see the admin dashboard.
const ADMIN_EMAIL = 'admin@thedeck.com';

const VALID_FEATURES = ['grading', 'valuing', 'auction', 'search'];
// Free plan (or an expired trial) can only use these two features, and
// only up to FREE_WEEKLY_LIMIT total uses of them per rolling 7 days.
const FREE_ALLOWED_FEATURES = ['grading', 'valuing'];
const FREE_WEEKLY_LIMIT = 10;

function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

// Reads the "Authorization: Bearer <token>" header, verifies it, and
// attaches the logged-in user's id/email to the request.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
}

// Must run after requireAuth (needs req.userEmail already set).
function requireAdmin(req, res, next) {
  if (req.userEmail !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// 'pro' -> unlimited. 'trial' -> unlimited until trial_ends_at passes.
// Everything else (including an expired trial) is treated as 'free'.
function effectivePlan(user) {
  if (user.plan === 'pro') return 'pro';
  if (user.plan === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) > new Date()) {
    return 'trial';
  }
  return 'free';
}

// Category IDs on eBay that cover trading cards (sports + non-sport + TCG singles)
const CARD_CATEGORY_IDS = '212,2536,183454';

// Simple in-memory cache for the eBay OAuth token so we don't fetch a new
// one on every request. We refresh it a minute before it actually expires.
let cachedToken = null;
let tokenExpiresAt = 0;

async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const err = new Error('Missing eBay credentials (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set)');
    err.code = 'missing_credentials';
    throw err;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`eBay token request failed: ${response.status} - ${body}`);
    const err = new Error(`eBay token request failed: ${response.status}`);
    // eBay returns 401 for a bad/expired/wrong-environment client id or secret.
    err.code = response.status === 401 ? 'invalid_credentials' : 'ebay_unavailable';
    throw err;
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // Refresh a minute early to be safe.
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

  return cachedToken;
}

function formatDate(isoString) {
  const date = isoString ? new Date(isoString) : new Date();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function bucketForTitle(title) {
  const lower = title.toLowerCase();
  if (lower.includes('psa 10') || lower.includes('psa10')) return 'psa10';
  if (lower.includes('psa 9')) return 'psa9';
  if (lower.includes('psa 8')) return 'psa8';
  return 'raw';
}

function average(numbers) {
  // Filtering defensively (not just trusting every input is already a
  // valid number) matters here: a single bad value - NaN, undefined,
  // Infinity - poisons the whole sum via NaN propagation, and
  // JSON.stringify silently turns a NaN average into null on the wire,
  // which looks exactly like "no data" to the frontend instead of the
  // real bug it actually is.
  const valid = numbers.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (valid.length === 0) return null;
  const sum = valid.reduce((total, n) => total + n, 0);
  return Math.round(sum / valid.length);
}

const CARD_NUMBER_PATTERN = /\/\s*\d+/;
const MIN_VALID_PRICE = 5;

function isNumberedCardQuery(query) {
  return CARD_NUMBER_PATTERN.test(query);
}

function titleHasCardNumber(title) {
  return CARD_NUMBER_PATTERN.test(title);
}

// eBay's Browse API only accepts ONE category_ids value per request
// (allowedMaxCategories: 1), so covering all three card categories means
// firing one request per category and merging the results ourselves.
function buildSearchUrl(query, categoryId, filter, limit) {
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query);
  url.searchParams.set('category_ids', categoryId);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('filter', filter);
  return url;
}

async function fetchItems(url, headers, label) {
  try {
    const r = await fetch(url, { headers });
    if (r.ok) return { ok: true, items: (await r.json()).itemSummaries || [] };
    console.error(`${label} failed: ${r.status} - ${await r.text().catch(() => '')}`);
    return { ok: false, items: [] };
  } catch (e) {
    console.error(`${label} errored:`, e.message);
    return { ok: false, items: [] };
  }
}

app.use(require('express').static('public'));

// ===== ACCOUNTS =====

app.post('/api/signup', async (req, res) => {
  const { email, password, ref } = req.body || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'invalid_password' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: 'email_taken' });
  }

  // If `ref` matches someone's referral code, remember who referred this
  // new user. An unknown/missing ref code is fine - just no referrer.
  let referredBy = null;
  if (ref) {
    const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(ref);
    if (referrer) referredBy = referrer.id;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const referralCode = uniqueReferralCode();

  const info = db.prepare(`
    INSERT INTO users (email, password_hash, created_at, plan, trial_ends_at, referral_code, referred_by)
    VALUES (?, ?, ?, 'trial', ?, ?, ?)
  `).run(normalizedEmail, passwordHash, now.toISOString(), trialEndsAt.toISOString(), referralCode, referredBy);

  const token = signToken({ id: info.lastInsertRowid, email: normalizedEmail });
  res.json({ token });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) return res.status(401).json({ error: 'invalid_credentials' });

  const token = signToken(user);
  res.json({ token });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const usageRows = db.prepare(`
    SELECT feature, COUNT(*) as count FROM usage
    WHERE user_id = ? AND created_at >= ?
    GROUP BY feature
  `).all(user.id, weekAgo);

  const weeklyUsage = {};
  VALID_FEATURES.forEach((f) => { weeklyUsage[f] = 0; });
  usageRows.forEach((r) => { weeklyUsage[r.feature] = r.count; });

  res.json({
    email: user.email,
    plan: effectivePlan(user),
    trial_ends_at: user.trial_ends_at,
    referral_code: user.referral_code,
    weekly_usage: weeklyUsage,
  });
});

// Checks (and records) whether the logged-in user is allowed to use a
// feature right now, based on their plan and this week's usage.
app.post('/api/use', requireAuth, (req, res) => {
  const { feature, detail } = req.body || {};
  if (!VALID_FEATURES.includes(feature)) {
    return res.status(400).json({ error: 'invalid_feature' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const plan = effectivePlan(user);

  if (plan === 'pro' || plan === 'trial') {
    db.prepare('INSERT INTO usage (user_id, feature, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, feature, detail || null, new Date().toISOString());
    return res.json({ allowed: true, remaining: null }); // null = unlimited
  }

  // Free plan (or an expired trial): only grading/valuing, capped
  // combined at FREE_WEEKLY_LIMIT uses per rolling 7 days, no auction.
  if (!FREE_ALLOWED_FEATURES.includes(feature)) {
    return res.json({ allowed: false, remaining: 0 });
  }

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const placeholders = FREE_ALLOWED_FEATURES.map(() => '?').join(',');
  const usedRow = db.prepare(`
    SELECT COUNT(*) as count FROM usage
    WHERE user_id = ? AND feature IN (${placeholders}) AND created_at >= ?
  `).get(user.id, ...FREE_ALLOWED_FEATURES, weekAgo);

  const remainingBefore = Math.max(0, FREE_WEEKLY_LIMIT - usedRow.count);
  if (remainingBefore <= 0) {
    return res.json({ allowed: false, remaining: 0 });
  }

  db.prepare('INSERT INTO usage (user_id, feature, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(user.id, feature, detail || null, new Date().toISOString());

  res.json({ allowed: true, remaining: remainingBefore - 1 });
});

// ===== ADMIN DASHBOARD =====

app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dailyActiveUsers = db.prepare(
    'SELECT COUNT(DISTINCT user_id) as count FROM usage WHERE created_at >= ?'
  ).get(dayAgo).count;

  // "Active user" here = anyone with at least one usage row, ever (not
  // just the last 24h) - average uses per active user, all-time.
  const totalUsageRows = db.prepare('SELECT COUNT(*) as count FROM usage').get().count;
  const activeUserCount = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM usage').get().count;
  const avgUsesPerActiveUser = activeUserCount > 0
    ? Math.round((totalUsageRows / activeUserCount) * 10) / 10
    : 0;

  // Signups for each of the last 30 days, zero-filled so there are no
  // gaps for the admin page's chart to deal with.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const signupRows = db.prepare(`
    SELECT substr(created_at, 1, 10) as day, COUNT(*) as count
    FROM users
    WHERE created_at >= ?
    GROUP BY day
  `).all(thirtyDaysAgo);
  const signupsByDay = {};
  signupRows.forEach((r) => { signupsByDay[r.day] = r.count; });
  const signupsPerDay = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    signupsPerDay.push({ date: day, count: signupsByDay[day] || 0 });
  }

  const featureRows = db.prepare('SELECT feature, COUNT(*) as count FROM usage GROUP BY feature').all();
  const featureUsage = {};
  VALID_FEATURES.forEach((f) => { featureUsage[f] = 0; });
  featureRows.forEach((r) => { featureUsage[r.feature] = r.count; });

  const topSearches = db.prepare(`
    SELECT detail as term, COUNT(*) as count
    FROM usage
    WHERE feature = 'search' AND detail IS NOT NULL AND detail != ''
    GROUP BY detail
    ORDER BY count DESC
    LIMIT 20
  `).all();

  const users = db.prepare(`
    SELECT
      u.email,
      u.plan,
      u.created_at,
      (SELECT COUNT(*) FROM usage WHERE user_id = u.id) as total_uses,
      (SELECT MAX(created_at) FROM usage WHERE user_id = u.id) as last_active
    FROM users u
    ORDER BY u.created_at DESC
  `).all();

  res.json({ totalUsers, dailyActiveUsers, avgUsesPerActiveUser, signupsPerDay, featureUsage, topSearches, users });
});

// ===== PSA CERT LOOKUP =====
// The cert number printed on a PSA slab is the one thing OCR reads
// reliably (it's just digits) - looking it up directly against PSA's own
// database gets the real card details instead of guessing from garbled
// label text.
const PSA_API_BASE = 'https://api.psacard.com/publicapi';

app.get('/api/psa-cert/:cert', async (req, res) => {
  const cert = (req.params.cert || '').trim();
  if (!/^\d{6,10}$/.test(cert)) {
    return res.json({ error: 'invalid_cert' });
  }

  const token = process.env.PSA_API_TOKEN;
  if (!token) {
    return res.json({ error: 'missing_psa_token' });
  }

  try {
    const response = await fetch(`${PSA_API_BASE}/cert/GetByCertNumber/${cert}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`PSA cert lookup failed: ${response.status} - ${body}`);
      const code = (response.status === 401 || response.status === 403) ? 'invalid_psa_token' : 'psa_unavailable';
      return res.json({ error: code });
    }

    const data = await response.json();
    // Logged so the exact field names PSA actually returns can be checked
    // and the mapping below adjusted if it's not quite right - this is
    // built from the public API docs, not a real test call.
    console.log('PSA cert raw response:', JSON.stringify(data));

    const c = data.PSACert || data.psaCert || data;
    const card = {
      certNumber: cert,
      year: c.Year || c.year || '',
      brand: c.Brand || c.brand || '',
      category: c.Category || c.category || '',
      subject: c.Subject || c.subject || '', // usually the player/character name
      cardNumber: c.CardNumber || c.cardNumber || '',
      variety: c.Variety || c.variety || '',
      grade: c.CardGrade || c.Grade || c.grade || '',
    };

    if (!card.subject && !card.brand) {
      return res.json({ error: 'cert_not_found' });
    }

    // A ready-to-search query string, so the frontend doesn't have to
    // duplicate this assembly logic.
    const queryParts = [card.year, card.brand, card.subject, card.variety].filter(Boolean);
    if (card.grade) queryParts.push('PSA ' + card.grade);
    card.query = queryParts.join(' ').trim();

    res.json({ card });
  } catch (err) {
    console.error('PSA cert lookup errored:', err.message);
    res.json({ error: 'psa_unavailable' });
  }
});

// ===== CARDSIGHT SOLD-PRICE DATA =====
// eBay's Browse API only exposes active/asking listings, never confirmed
// sales - CardSight gives real sold prices, split into "auction" (a real
// completed sale) vs "fixed" (just an asking price, nobody's paid it).
// Never throws - always resolves to { ok, ... } so a CardSight problem
// can never take down the rest of /api/price.
const CARDSIGHT_API_BASE = 'https://api.cardsight.ai/v1';

function splitByListingType(listings) {
  const sold = [];
  const asking = [];
  (listings || []).forEach((l) => {
    const price = typeof l.price === 'number' ? l.price : parseFloat(l.price);
    if (Number.isNaN(price)) return;
    if (l.listing_type === 'auction') sold.push(price);
    else if (l.listing_type === 'fixed') asking.push(price);
  });
  return {
    sold: { avg: average(sold), count: sold.length },
    asking: { avg: average(asking), count: asking.length },
  };
}

// Reshapes CardSight's { raw, graded: { COMPANY: { GRADE: {...} } } }
// response into the same { sold, asking } pairs at every level, so the
// rest of the code doesn't need to know CardSight's raw shape.
function normalizeCardSightPricing(data) {
  const raw = splitByListingType(data.raw && data.raw.listings);

  const graded = {};
  const gradedData = data.graded || {};
  Object.keys(gradedData).forEach((company) => {
    graded[company] = {};
    const grades = gradedData[company] || {};
    Object.keys(grades).forEach((grade) => {
      graded[company][grade] = splitByListingType(grades[grade] && grades[grade].listings);
    });
  });

  return { raw, graded };
}

async function fetchCardSightPricing(query) {
  const key = process.env.CARDSIGHT_API_KEY;
  if (!key) return { ok: false, reason: 'missing_key' };

  try {
    const url = `${CARDSIGHT_API_BASE}/pricing/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`CardSight pricing lookup failed: ${response.status} - ${body}`);
      return { ok: false, reason: response.status === 401 || response.status === 403 ? 'invalid_key' : 'unavailable' };
    }

    let data = await response.json();
    // Defensive: handle either a single card object or a list of matches
    // (the search endpoint's exact shape for multiple matches isn't
    // documented here) by taking the first result if it's an array.
    if (Array.isArray(data)) data = data[0];
    if (!data || (!data.raw && !data.graded)) {
      return { ok: false, reason: 'no_data' };
    }

    return { ok: true, pricing: normalizeCardSightPricing(data) };
  } catch (err) {
    console.error('CardSight pricing lookup errored:', err.message);
    return { ok: false, reason: 'unavailable' };
  }
}

app.get('/api/price', async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.json({ error: 'ebay_unavailable' });
  }

  try {
    const token = await getEbayToken();

    const ebayHeaders = {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    };

    const categoryIds = CARD_CATEGORY_IDS.split(',');

    // Run every category's main search, auction search, AND the CardSight
    // sold-price lookup all at the same time - CardSight can never slow
    // this down or fail the request, since fetchCardSightPricing always
    // resolves (never throws/rejects).
    const [mainResults, auctionResults, cardsight] = await Promise.all([
      Promise.all(categoryIds.map((catId) =>
        fetchItems(
          buildSearchUrl(query, catId, 'buyingOptions:{FIXED_PRICE|AUCTION|BEST_OFFER}', 30),
          ebayHeaders,
          `eBay search (category ${catId})`
        )
      )),
      Promise.all(categoryIds.map((catId) =>
        fetchItems(
          buildSearchUrl(query, catId, 'buyingOptions:{AUCTION}', 10),
          ebayHeaders,
          `eBay auction search (category ${catId})`
        )
      )),
      fetchCardSightPricing(query),
    ]);

    if (!mainResults.some((r) => r.ok)) {
      throw new Error('eBay search failed for every card category');
    }

    const seen = new Set();
    const items = [...mainResults, ...auctionResults].flatMap((r) => r.items).filter(function(i){
      if (seen.has(i.itemId)) return false;
      seen.add(i.itemId);
      return true;
    });

    const wantsNumberedCard = isNumberedCardQuery(query);

    const buckets = { raw: [], psa8: [], psa9: [], psa10: [] };
    const compsArr = [];
    const listings = [];

    for (const item of items) {
      // Active AUCTION listings carry their live bid under
      // currentBidPrice, not price - price is often missing entirely for
      // them, which is why auction items were producing $NaN before.
      const priceField = item.price || item.currentBidPrice;
      const price = priceField && parseFloat(priceField.value);
      if (!item.title || typeof price !== 'number' || Number.isNaN(price)) continue;
      if (price < MIN_VALID_PRICE) continue;
      if (wantsNumberedCard && !titleHasCardNumber(item.title)) continue;

      const grade = bucketForTitle(item.title);
      buckets[grade].push(price);
      compsArr.push({ t: item.title, p: Math.round(price), grade });

      listings.push({
        type: (item.buyingOptions || []).includes('AUCTION') ? 'Auction' : 'Buy It Now',
        bids: item.bidCount || 0,
        date: formatDate(item.itemCreationDate),
        price: `$${Math.round(price)}`,
        title: item.title,
        image: item.image ? item.image.imageUrl : '',
        url: item.itemWebUrl,
        _sortDate: item.itemCreationDate || '',
      });
    }

    listings.sort((a, b) => (a._sortDate < b._sortDate ? 1 : -1));
    const auctionListings = listings.filter((l) => l.type === 'Auction');
    const buyNowListings = listings.filter((l) => l.type !== 'Auction');
    console.log('auction listings found:', auctionListings.length);
    const mixed = [...auctionListings.slice(0, 4), ...buyNowListings].slice(0, 10);
    mixed.sort((a, b) => (a._sortDate < b._sortDate ? 1 : -1));
    const recentSales = mixed.map(({ _sortDate, ...rest }) => rest);

    // A price bucket prefers CardSight's real SOLD price (source: 'sold').
    // If CardSight has no sold data for this bucket, falls back to eBay's
    // active-listing average instead (source: 'ebay_listings') - same
    // number the app has always shown, just now clearly labeled as an
    // asking-price approximation rather than a confirmed sale.
    function buildStatBucket(cardsightBucket, ebayPrices) {
      if (cardsightBucket && cardsightBucket.sold.avg !== null) {
        return { avg: cardsightBucket.sold.avg, asking: cardsightBucket.asking.avg, source: 'sold' };
      }
      const ebayAvg = average(ebayPrices);
      return { avg: ebayAvg, asking: null, source: ebayAvg !== null ? 'ebay_listings' : null };
    }

    const psaGraded = (cardsight.ok && cardsight.pricing.graded.PSA) || {};
    const stats = {
      raw: buildStatBucket(cardsight.ok ? cardsight.pricing.raw : null, buckets.raw),
      psa8: buildStatBucket(psaGraded['8'], buckets.psa8),
      psa9: buildStatBucket(psaGraded['9'], buckets.psa9),
      psa10: buildStatBucket(psaGraded['10'], buckets.psa10),
    };

    // Anything CardSight returned beyond the raw/PSA-8/9/10 boxes above -
    // other companies (BGS, SGC, ...) or other grades (9.5, 7, ...) - so
    // that data isn't silently dropped on the floor.
    const otherGrades = [];
    if (cardsight.ok) {
      Object.keys(cardsight.pricing.graded).forEach((company) => {
        Object.keys(cardsight.pricing.graded[company]).forEach((grade) => {
          if (company === 'PSA' && ['8', '9', '10'].includes(grade)) return;
          const bucket = cardsight.pricing.graded[company][grade];
          if (bucket.sold.avg === null && bucket.asking.avg === null) return;
          otherGrades.push({ company, grade, sold: bucket.sold, asking: bucket.asking });
        });
      });
    }

    res.json({
      validResults: buckets.raw.length + buckets.psa8.length + buckets.psa9.length + buckets.psa10.length,
      isListings: true,
      hasSoldData: cardsight.ok,
      stats,
      otherGrades,
      recentSales,
      comps: compsArr,
    });
  } catch (err) {
    console.error('eBay price lookup failed:', err.message);
    res.json({ error: err.code || 'ebay_unavailable' });
  }
});

app.listen(PORT, () => {
  console.log(`The Deck backend running on http://localhost:${PORT}`);
});
