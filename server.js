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
    throw new Error('Missing eBay credentials');
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
    throw new Error(`eBay token request failed: ${response.status}`);
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

app.get('/api/price', async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.json({ error: 'ebay_unavailable' });
  }

  try {
    const token = await getEbayToken();

    const searchUrl = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('limit', '50');
    searchUrl.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE|AUCTION|BEST_OFFER}');

    const searchResponse = await fetch(searchUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });

    if (!searchResponse.ok) {
      throw new Error(`eBay search failed: ${searchResponse.status}`);
    }

    const searchData = await searchResponse.json();
    const auctionUrl = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
    auctionUrl.searchParams.set('q', query);
    auctionUrl.searchParams.set('limit', '20');
    auctionUrl.searchParams.set('filter', 'buyingOptions:{AUCTION}');
    let auctionItems = [];
    try {
      const ar = await fetch(auctionUrl, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
      if (ar.ok) auctionItems = (await ar.json()).itemSummaries || [];
    } catch (e) {}
    const seen = new Set();
    const items = [...(searchData.itemSummaries || []), ...auctionItems].filter(function(i){
      if (seen.has(i.itemId)) return false;
      seen.add(i.itemId);
      return true;
    });

    const buckets = { raw: [], psa8: [], psa9: [], psa10: [] };
    const listings = [];

    for (const item of items) {
      const price = item.price && parseFloat(item.price.value);
      if (!item.title || Number.isNaN(price)) continue;

      buckets[bucketForTitle(item.title)].push(price);

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
    });
  } catch (err) {
    console.error('eBay price lookup failed:', err.message);
    res.json({ error: 'ebay_unavailable' });
  }
});

app.listen(PORT, () => {
  console.log(`The Deck backend running on http://localhost:${PORT}`);
});
