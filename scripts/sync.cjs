const https = require('https');
const fs = require('fs');

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
// Fetch from Jan 1st of current year
const DAYS_BACK = Math.ceil((Date.now() - new Date(new Date().getFullYear(),0,1).getTime()) / 86400000) + 1;

// Frozen spend from old Meta ad account (pre-04/30) — immutable
const FROZEN_SPEND = {
  '2026-03-30':179.62,'2026-03-31':197.14,'2026-04-01':141.70,'2026-04-02':167.43,
  '2026-04-03':207.61,'2026-04-04':197.57,'2026-04-05':284.27,'2026-04-06':199.77,
  '2026-04-07':304.73,'2026-04-08':236.62,'2026-04-09':140.58,'2026-04-10':280.61,
  '2026-04-11':371.95,'2026-04-12':267.01,'2026-04-13':119.16,'2026-04-14':117.73,
  '2026-04-15':135.29,'2026-04-16':205.31,'2026-04-17':77.62,'2026-04-18':4.68,
  '2026-04-21':92.85,'2026-04-22':254.08,'2026-04-23':234.47,'2026-04-24':311.04,
  '2026-04-25':262.59,'2026-04-26':341.80,'2026-04-27':457.17,'2026-04-28':462.91,
  '2026-04-29':369.91
};

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, headers: { 'User-Agent': 'VividCraft-Sync', ...headers } };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ body: JSON.parse(data), headers: res.headers }); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function parseLinkNext(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function dateStr(d) { return d.toISOString().split('T')[0]; }

async function fetchShopifyOrders() {
  const since = new Date();
  since.setDate(since.getDate() - DAYS_BACK);
  const sinceStr = since.toISOString();

  let allOrders = [];
  let url = `https://${SHOPIFY_DOMAIN}/admin/api/2024-10/orders.json?created_at_min=${sinceStr}&status=any&limit=250`;

  while (url) {
    console.log(`Fetching Shopify orders... (${allOrders.length} so far)`);
    const res = await httpGet(url, { 'X-Shopify-Access-Token': SHOPIFY_TOKEN });
    if (res.body.errors) throw new Error(`Shopify error: ${JSON.stringify(res.body.errors)}`);
    allOrders = allOrders.concat(res.body.orders || []);
    url = parseLinkNext(res.headers.link);
  }

  console.log(`Fetched ${allOrders.length} Shopify orders`);

  // Map product titles to SKUs for orders placed before SKUs were assigned
  const titleToSku = {
    'Digital Color Mixing Guide': 'VC_MIXGUIDE',
    'Free Shipping': 'VC_FREESHIP',
    'Coloring eBook': 'VC_EBOOK',
    'Cozy Japan Coloring Book': 'VC_COLORBOOK_JAPAN',
    'Little Corners Coloring Book': 'VC_COLORBOOK_CORNERS',
    'Step-by-Step Art Book with Practice Pages': 'VC_ARTBOOK_STEPBYSTEP'
  };

  // Group by date in Europe/Amsterdam (same as Meta ad account) for spend alignment
  const byDate = {};
  allOrders.forEach(o => {
    const date = new Date(o.created_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (!byDate[date]) byDate[date] = { revenue: 0, cmds: [] };
    byDate[date].revenue += parseFloat(o.total_price);
    const items = {};
    o.line_items.forEach(li => {
      const sku = li.sku || titleToSku[li.title] || 'UNKNOWN';
      items[sku] = (items[sku] || 0) + li.quantity;
    });
    const h = parseInt(new Date(o.created_at).toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}))||0;
    byDate[date].cmds.push({ id: o.name || o.order_number, items, h, rev: parseFloat(o.total_price)||0 });
  });

  return byDate;
}

// Only fetch last 3 days from Meta (older days are frozen in cache)
const FRESH_DAYS = 3;

async function fetchMetaSpend() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    console.log('Meta credentials not configured, skipping Meta spend');
    return {};
  }

  const since = new Date();
  since.setDate(since.getDate() - FRESH_DAYS);
  const sinceStr = dateStr(since);
  const untilStr = dateStr(new Date());

  const url = `https://graph.facebook.com/v21.0/${META_AD_ACCOUNT_ID}/insights?fields=spend,date_start&time_increment=1&time_range={"since":"${sinceStr}","until":"${untilStr}"}&limit=10&access_token=${META_ACCESS_TOKEN}`;

  console.log(`Fetching Meta spend (last ${FRESH_DAYS} days)...`);
  const res = await httpGet(url);

  if (res.body.error) {
    console.error(`Meta API error: ${res.body.error.message}`);
    return {};
  }

  const spendByDate = {};
  (res.body.data || []).forEach(row => {
    spendByDate[row.date_start] = parseFloat(row.spend) || 0;
  });

  console.log(`Fetched Meta spend for ${Object.keys(spendByDate).length} days`);
  return spendByDate;
}

async function main() {
  console.log('Starting sync...');

  // Load cached spend from existing data.json
  let cachedSpend = {};
  try {
    const existing = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    (existing.daily || []).forEach(d => {
      if (d.spend > 0) cachedSpend[d.date] = d.spend;
    });
    console.log(`Loaded ${Object.keys(cachedSpend).length} cached spend days from data.json`);
  } catch(e) { console.log('No existing data.json, starting fresh'); }

  const shopifyData = await fetchShopifyOrders();
  const freshSpend = await fetchMetaSpend();

  // Merge: frozen > fresh API (last 3 days) > cached > 0
  const allDates = new Set([...Object.keys(shopifyData), ...Object.keys(freshSpend), ...Object.keys(cachedSpend), ...Object.keys(FROZEN_SPEND)]);
  const sorted = [...allDates].sort();

  const daily = sorted.map(date => {
    const shop = shopifyData[date] || { revenue: 0, cmds: [] };
    let spend;
    if (FROZEN_SPEND[date] !== undefined) spend = FROZEN_SPEND[date];
    else if (freshSpend[date] !== undefined) spend = freshSpend[date];
    else if (cachedSpend[date] !== undefined) spend = cachedSpend[date];
    else spend = 0;
    return {
      date,
      label: date.slice(5).replace('-', '/'),
      orders: shop.cmds.length,
      revenue: Math.round(shop.revenue * 100) / 100,
      spend,
      cmds: shop.cmds
    };
  });

  // Collect all unique SKUs seen
  const skuSet = new Set();
  daily.forEach(d => d.cmds.forEach(cmd => Object.keys(cmd).forEach(sku => skuSet.add(sku))));

  const output = {
    lastUpdated: new Date().toISOString(),
    daily,
    skusSeen: [...skuSet].sort()
  };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Written data.json: ${daily.length} days, ${daily.reduce((a, d) => a + d.orders, 0)} orders`);
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
