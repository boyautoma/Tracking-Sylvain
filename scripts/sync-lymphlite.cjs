const https = require('https');
const fs = require('fs');

const SHOPIFY_TOKEN = process.env.LYMPHLITE_SHOPIFY_TOKEN;
const SHOPIFY_DOMAIN = process.env.LYMPHLITE_SHOPIFY_DOMAIN;
const META_ACCESS_TOKEN = process.env.LYMPHLITE_META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.LYMPHLITE_META_AD_ACCOUNT_ID;
const DAYS_BACK = 30;

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, headers: { 'User-Agent': 'Lymphlite-Sync', ...headers } };
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
  if (!SHOPIFY_TOKEN || !SHOPIFY_DOMAIN) {
    console.log('Lymphlite Shopify credentials not configured, skipping orders');
    return {};
  }

  const since = new Date();
  since.setDate(since.getDate() - DAYS_BACK);
  const sinceStr = since.toISOString();

  let allOrders = [];
  let url = `https://${SHOPIFY_DOMAIN}/admin/api/2024-10/orders.json?created_at_min=${sinceStr}&status=any&limit=250`;

  while (url) {
    console.log(`Fetching Lymphlite Shopify orders...`);
    const res = await httpGet(url, { 'X-Shopify-Access-Token': SHOPIFY_TOKEN });
    if (res.body.errors) throw new Error(`Shopify error: ${JSON.stringify(res.body.errors)}`);
    allOrders = allOrders.concat(res.body.orders || []);
    url = parseLinkNext(res.headers.link);
  }

  console.log(`Fetched ${allOrders.length} Lymphlite Shopify orders`);

  const byDate = {};
  allOrders.forEach(o => {
    const date = new Date(o.created_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (!byDate[date]) byDate[date] = { revenue: 0, cmds: [] };
    byDate[date].revenue += parseFloat(o.total_price);
    const items = {};
    o.line_items.forEach(li => {
      const sku = li.sku || li.title || 'UNKNOWN';
      items[sku] = (items[sku] || 0) + li.quantity;
    });
    const country = (o.shipping_address && o.shipping_address.country_code) || 'US';
    const h = parseInt(new Date(o.created_at).toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}))||0;
    byDate[date].cmds.push({ id: o.name || o.order_number, items, country, h, rev: parseFloat(o.total_price)||0 });
  });

  return byDate;
}

async function fetchMetaSpend() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    console.log('Lymphlite Meta credentials not configured, skipping Meta spend');
    return {};
  }

  const since = new Date();
  since.setDate(since.getDate() - DAYS_BACK);
  const sinceStr = dateStr(since);
  const untilStr = dateStr(new Date());

  const url = `https://graph.facebook.com/v21.0/${META_AD_ACCOUNT_ID}/insights?fields=spend,date_start&time_increment=1&time_range={"since":"${sinceStr}","until":"${untilStr}"}&limit=100&access_token=${META_ACCESS_TOKEN}`;

  console.log('Fetching Lymphlite Meta spend...');
  const res = await httpGet(url);

  if (res.body.error) {
    console.error(`Meta API error: ${res.body.error.message}`);
    return {};
  }

  const spendByDate = {};
  (res.body.data || []).forEach(row => {
    spendByDate[row.date_start] = parseFloat(row.spend) || 0;
  });

  console.log(`Fetched Lymphlite Meta spend for ${Object.keys(spendByDate).length} days`);
  return spendByDate;
}

async function main() {
  console.log('Starting Lymphlite sync...');

  let shopifyData = {};
  try { shopifyData = await fetchShopifyOrders(); }
  catch (e) { console.log('Shopify fetch failed (non-blocking):', e.message); }

  const metaSpend = await fetchMetaSpend();

  const allDates = new Set([...Object.keys(shopifyData), ...Object.keys(metaSpend)]);
  const sorted = [...allDates].sort();

  const daily = sorted.map(date => {
    const shop = shopifyData[date] || { revenue: 0, cmds: [] };
    const spend = metaSpend[date] || 0;
    return {
      date,
      label: date.slice(5).replace('-', '/'),
      orders: shop.cmds.length,
      revenue: Math.round(shop.revenue * 100) / 100,
      spend,
      cmds: shop.cmds
    };
  });

  const skuSet = new Set();
  daily.forEach(d => d.cmds.forEach(cmd => Object.keys(cmd.items || cmd).forEach(sku => skuSet.add(sku))));

  const output = {
    lastUpdated: new Date().toISOString(),
    daily,
    skusSeen: [...skuSet].sort()
  };

  fs.writeFileSync('lymphlite-data.json', JSON.stringify(output, null, 2));
  console.log(`Written lymphlite-data.json: ${daily.length} days, ${daily.reduce((a, d) => a + d.orders, 0)} orders`);
}

main().catch(err => {
  console.error('Lymphlite sync failed:', err);
  process.exit(1);
});
