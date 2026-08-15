require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3001;

app.use(cors());

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
  if (numbers.length === 0) return null;
  const sum = numbers.reduce((total, n) => total + n, 0);
  return Math.round(sum / numbers.length);
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

    // Run every category's main search and auction search at the same time
    // instead of one after another, so this doesn't take 6x as long.
    const [mainResults, auctionResults] = await Promise.all([
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
      const price = item.price && parseFloat(item.price.value);
      if (!item.title || Number.isNaN(price)) continue;
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

    res.json({
      validResults: buckets.raw.length + buckets.psa8.length + buckets.psa9.length + buckets.psa10.length,
      isListings: true,
      stats: {
        raw: { avg: average(buckets.raw) },
        psa8: { avg: average(buckets.psa8) },
        psa9: { avg: average(buckets.psa9) },
        psa10: { avg: average(buckets.psa10) },
      },
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
