const https = require('https');
const fs = require('fs');

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const DAYS_BACK = 30;

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, headers: { 'User-Agent': 'VividCraft-Sync', ...headers } };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function dateStr(d) { return d.toISOString().split('T')[0]; }

async function fetchShopifyOrders() {
  const since = new Date();
  since.setDate(since.getDate() - DAYS_BACK);
  const sinceStr = since.toISOString();

  let allOrders = [];
  let url = `https://${SHOPIFY_DOMAIN}/admin/api/2024-10/orders.json?created_at_min=${sinceStr}&status=any&limit=250`;

  while (url) {
    console.log(`Fetching Shopify orders...`);
    const res = await httpGet(url, { 'X-Shopify-Access-Token': SHOPIFY_TOKEN });
    if (res.errors) throw new Error(`Shopify error: ${JSON.stringify(res.errors)}`);
    allOrders = allOrders.concat(res.orders || []);
    // Pagination via Link header not available in simple https.get, but 250 limit should cover 30 days
    url = null;
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
    byDate[date].cmds.push({ id: o.name || o.order_number, items });
  });

  return byDate;
}

async function fetchMetaSpend() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    console.log('Meta credentials not configured, skipping Meta spend');
    return {};
  }

  const since = new Date();
  since.setDate(since.getDate() - DAYS_BACK);
  const sinceStr = dateStr(since);
  const untilStr = dateStr(new Date());

  const url = `https://graph.facebook.com/v21.0/${META_AD_ACCOUNT_ID}/insights?fields=spend,date_start&time_increment=1&time_range={"since":"${sinceStr}","until":"${untilStr}"}&limit=100&access_token=${META_ACCESS_TOKEN}`;

  console.log('Fetching Meta spend...');
  const res = await httpGet(url);

  if (res.error) {
    console.error(`Meta API error: ${res.error.message}`);
    return {};
  }

  const spendByDate = {};
  (res.data || []).forEach(row => {
    spendByDate[row.date_start] = parseFloat(row.spend) || 0;
  });

  console.log(`Fetched Meta spend for ${Object.keys(spendByDate).length} days`);
  return spendByDate;
}

async function main() {
  console.log('Starting sync...');

  const shopifyData = await fetchShopifyOrders();
  const metaSpend = await fetchMetaSpend();

  // Merge into DAILY format
  const allDates = new Set([...Object.keys(shopifyData), ...Object.keys(metaSpend)]);
  const sorted = [...allDates].sort();

  const daily = sorted.map(date => {
    const shop = shopifyData[date] || { revenue: 0, cmds: [] };
    return {
      date,
      label: date.slice(5).replace('-', '/'),
      orders: shop.cmds.length,
      revenue: Math.round(shop.revenue * 100) / 100,
      spend: metaSpend[date] || 0,
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
