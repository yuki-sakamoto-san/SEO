// File: headings_scraper_full.js
//
// ✅ Guarantees unlimited H1–H6 capture (document + open shadow DOM + ARIA role=heading)
// ✅ Builds columns AFTER extraction, so no headings get dropped (no hard cap like 3)
// ✅ Optional: fetch SERP top results via SerpAPI (country-wide via city sampling)
// ✅ Optional: push directly to Google Sheets; otherwise writes serp_headings.csv
//
// --- Install ---
// npm i playwright googleapis axios csv-writer
//
// --- Run (SERP via SerpAPI) ---
// node headings_scraper_full.js --query="ERP" --country="Australia" --language="en" \
//   --apiKey="YOUR_SERPAPI_API_KEY" \
//   --maxCities=6 --maxUnique=10 \
//   --sheetId="YOUR_SHEET_ID" --sheetName="Sheet1" --serviceAccountKey="./service_account.json"
//
// --- Run (direct URLs, no SerpAPI) ---
// node headings_scraper_full.js --urls="https://example.com,https://example.org"
//
// Notes:
// - HTML only defines H1..H6; there is no H7. Styled section titles are mapped into those levels only if you enable the fallback block (disabled by default here).
//
// ---------------------------------------------------------------

const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');
const { google } = require('googleapis');
const { createObjectCsvWriter } = require('csv-writer');

/** ====================== CLI ====================== **/
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  out.country = out.country || 'Australia';
  out.language = out.language || 'en';
  out.maxCities = parseInt(out.maxCities || '6', 10);
  out.maxUnique = parseInt(out.maxUnique || '10', 10);
  out.sheetId = out.sheetId || process.env.SHEET_ID;
  out.sheetName = out.sheetName || process.env.SHEET_NAME || 'Sheet1';
  out.serviceAccountKey = out.serviceAccountKey || process.env.SERVICE_ACCOUNT_KEY;
  return out;
}

/** ====================== Optional: SerpAPI ====================== **/
const COUNTRY_CONFIG = {
  'Australia': { gl: 'au', google_domain: 'google.com.au', tz: 'Australia/Sydney',
    fallbackCities: ['Sydney, New South Wales, Australia','Melbourne, Victoria, Australia','Brisbane, Queensland, Australia','Perth, Western Australia, Australia','Adelaide, South Australia, Australia','Canberra, Australian Capital Territory, Australia','Hobart, Tasmania, Australia','Gold Coast, Queensland, Australia'] },
  'New Zealand': { gl: 'nz', google_domain: 'google.co.nz', tz: 'Pacific/Auckland',
    fallbackCities: ['Auckland, New Zealand','Wellington, New Zealand','Christchurch, Canterbury, New Zealand','Hamilton, Waikato, New Zealand','Tauranga, Bay Of Plenty, New Zealand','Dunedin, Otago, New Zealand'] },
  'Singapore': { gl: 'sg', google_domain: 'google.com.sg', tz: 'Asia/Singapore', fallbackCities: ['Singapore, Singapore'] },
  'Malaysia': { gl: 'my', google_domain: 'google.com.my', tz: 'Asia/Kuala_Lumpur',
    fallbackCities: ['Kuala Lumpur, Federal Territory of Kuala Lumpur, Malaysia','George Town, Penang, Malaysia','Johor Bahru, Johor, Malaysia','Kota Kinabalu, Sabah, Malaysia','Kuching, Sarawak, Malaysia'] },
  'India': { gl: 'in', google_domain: 'google.co.in', tz: 'Asia/Kolkata',
    fallbackCities: ['Mumbai, Maharashtra, India','Delhi, India','Bengaluru, Karnataka, India','Hyderabad, Telangana, India','Chennai, Tamil Nadu, India','Kolkata, West Bengal, India'] }
};

async function getTopCities(country, maxCities, apiKey) {
  if (!apiKey) return COUNTRY_CONFIG[country]?.fallbackCities.slice(0, Math.max(1, maxCities)) || [];
  try {
    const { data } = await axios.get('https://serpapi.com/locations.json', { params: { q: country, limit: 2000 } });
    const cities = (data || []).filter(loc => loc && loc.type === 'City' && (loc.country_name === country || loc.country === country));
    const names = cities.map(c => c.canonical_name);
    return (names.length ? names : COUNTRY_CONFIG[country].fallbackCities).slice(0, Math.max(1, maxCities));
  } catch {
    return COUNTRY_CONFIG[country]?.fallbackCities.slice(0, Math.max(1, maxCities)) || [];
  }
}

async function serpapiSearchCity({ query, language, cfg, location, apiKey }) {
  const params = {
    engine: 'google',
    q: query,
    google_domain: cfg.google_domain,
    gl: cfg.gl,
    hl: language,
    location,
    num: 10,
    device: 'desktop',
    no_cache: true,
    api_key: apiKey
  };
  const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 60000 });
  return (data.organic_results || []).map(r => r.link).filter(Boolean);
}

/** ====================== Playwright: Extraction ====================== **/
async function extractMeta(page) {
  return await page.evaluate(() => {
    const metaDesc = document.querySelector('meta[name="description"]');
    return { title: document.title || '', description: metaDesc?.getAttribute('content') || '' };
  });
}

// A) Unlimited H1–H6 (document + open shadow DOM + ARIA role=heading)
async function extractHeadingsNativeAndAria(page) {
  return await page.evaluate(() => {
    function normalize(t){ return (t || '').replace(/\s+/g,' ').trim(); }
    function* deepRoots(root = document) {
      yield root;
      const walker = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.shadowRoot && node.shadowRoot.mode === 'open') {
          yield* deepRoots(node.shadowRoot);
        }
      }
    }
    const out = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
    const push = (key, el) => {
      const rect = el.getBoundingClientRect?.() || { width:1, height:1 };
      if (rect.width === 0 || rect.height === 0) return; // visible only
      const text = normalize(el.innerText || el.textContent);
      if (text) out[key].push(text);
    };
    // 1) Native H*
    for (const root of deepRoots()) {
      ['h1','h2','h3','h4','h5','h6'].forEach(tag => root.querySelectorAll(tag).forEach(el => push(tag, el)));
    }
    // 2) role="heading" (ARIA)
    for (const root of deepRoots()) {
      root.querySelectorAll('[role="heading"]').forEach(el => {
        let lv = parseInt(el.getAttribute('aria-level'),10);
        if (!Number.isFinite(lv) || lv < 1 || lv > 6) lv = 2;
        push(`h${lv}`, el);
      });
    }
    return out; // {h1:[], h2:[], ...}
  });
}

// Optional fallback (disabled by default). Turn on if you need styled "pseudo-headings".
const USE_HEADING_LIKE_FALLBACK = false;
async function extractHeadingLikeFallback(page, existing) {
  if (!USE_HEADING_LIKE_FALLBACK) return existing;
  const extra = await page.evaluate(() => {
    function normalize(t){ return (t || '').replace(/\s+/g,' ').trim(); }
    function visible(el) {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    }
    const out = [];
    const walker = document.createNodeIterator(document, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const el = node;
      if (['H1','H2','H3','H4','H5','H6'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      const fw = cs.getPropertyValue('font-weight');
      const fwNum = parseInt(fw,10);
      const heavy = Number.isFinite(fwNum) ? fwNum >= 600 : ['bold','bolder'].includes(fw);
      const size = parseFloat(cs.getPropertyValue('font-size')) || 0;
      const idc = (el.id + ' ' + el.className).toLowerCase();
      const semantic = idc.includes('title') || idc.includes('heading') || idc.includes('headline') || idc.includes('section-title');
      if (!visible(el)) continue;
      if (!(heavy && size >= 18) && !semantic) continue;
      const txt = normalize(el.innerText || el.textContent);
      if (!txt) continue;
      let lv = 5;
      if (size >= 30) lv = 1;
      else if (size >= 24) lv = 2;
      else if (size >= 20) lv = 3;
      else if (size >= 18) lv = 4;
      out.push({ lv, txt });
    }
    return out;
  });
  const merged = { ...existing };
  for (const { lv, txt } of extra) {
    const key = `h${lv}`;
    if (!merged[key].includes(txt)) merged[key].push(txt);
  }
  return merged;
}

async function renderAndExtract(url, language, tz) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: language,
    timezoneId: tz || 'UTC',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const headers = { ...route.request().headers(), Referer: 'https://www.google.com/' };
    route.continue({ headers });
  });

  let ok = false;
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    const status = resp ? resp.status() : 0;
    if (status && status < 400) ok = true;
  } catch {}
  if (!ok) { await context.close(); await browser.close(); return null; }

  // Skip noindex
  const robots = await page.locator('meta[content*="noindex"]').first();
  if (await robots.count()) { await context.close(); await browser.close(); return null; }

  await page.waitForLoadState('networkidle', { timeout: 20000 });
  // incremental scroll to surface lazy sections
  await page.evaluate(async () => {
    await new Promise(res => {
      let scrolled = 0;
      const step = () => {
        window.scrollBy(0, 800);
        scrolled += 800;
        if (scrolled < document.body.scrollHeight + 2000) setTimeout(step, 120);
        else res();
      };
      step();
    });
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  const meta = await extractMeta(page);
  let headings = await extractHeadingsNativeAndAria(page);
  headings = await extractHeadingLikeFallback(page, headings);

  await context.close();
  await browser.close();
  return { url, meta, headings };
}

/** ====================== Output builders (B: dynamic headers) ====================== **/
function buildHeaderAndRows(pages) {
  const maxCols = { h1:0, h2:0, h3:0, h4:0, h5:0, h6:0 };
  for (const p of pages) {
    for (const lv of ['h1','h2','h3','h4','h5','h6']) {
      maxCols[lv] = Math.max(maxCols[lv], p.headings[lv]?.length || 0);
    }
  }
  const header = [
    { id:'URL', title:'URL' },
    { id:'MetaTitle', title:'MetaTitle' },
    { id:'MetaDescription', title:'MetaDescription' },
  ];
  for (const lv of ['h1','h2','h3','h4','h5','h6']) {
    for (let i=1; i<=maxCols[lv]; i++) {
      header.push({ id: `${lv.toUpperCase()}-${i}`, title: `${lv.toUpperCase()}-${i}` });
    }
  }
  const rows = pages.map(p => {
    const row = { URL: p.url, MetaTitle: p.meta.title || '', MetaDescription: p.meta.description || '' };
    for (const lv of ['h1','h2','h3','h4','h5','h6']) {
      const arr = p.headings[lv] || [];
      for (let i=1; i<=maxCols[lv]; i++) {
        row[`${lv.toUpperCase()}-${i}`] = arr[i-1] || '';
      }
    }
    return row;
  });
  return { header, rows };
}

/** ====================== Google Sheets (optional) ====================== **/
async function uploadToGoogleSheet({ rows, header, sheetId, sheetName, serviceAccountKey }) {
  const auth = new google.auth.GoogleAuth({ keyFile: serviceAccountKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const headers = header.map(h => h.title);
  const values = [headers, ...rows.map(r => header.map(h => r[h.id] ?? ''))];
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `${sheetName}!A:ZZ` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  console.log(`✅ Uploaded to Google Sheet: https://docs.google.com/spreadsheets/d/${sheetId} (tab: ${sheetName})`);
}

/** ====================== CSV (fallback) ====================== **/
async function writeCsv(path, header, rows) {
  const csvWriter = createObjectCsvWriter({ path, header });
  await csvWriter.writeRecords(rows);
  console.log(`💾 Wrote ${path}`);
}

/** ====================== Main ====================== **/
(async () => {
  const argv = parseArgs();
  const cfg = COUNTRY_CONFIG[argv.country] || { tz: 'UTC' };

  // 1) Gather URLs
  let urls = [];
  if (argv.urls) {
    urls = argv.urls.split(',').map(s => s.trim()).filter(Boolean);
  } else if (argv.query && argv.apiKey) {
    const cities = await getTopCities(argv.country, argv.maxCities, argv.apiKey);
    const set = new Map();
    for (const city of cities) {
      try {
        const links = await serpapiSearchCity({ query: argv.query, language: argv.language, cfg, location: city, apiKey: argv.apiKey });
        for (const u of links) {
          const norm = u.replace(/#.*$/, '');
          set.set(norm, (set.get(norm) || 0) + 1);
        }
      } catch (e) {
        console.error('City failed:', city, e.message);
      }
    }
    urls = [...set.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, argv.maxUnique).map(([u]) => u);
  } else {
    console.error('Provide --urls="comma,separated,urls" OR SerpAPI mode with --query, --country, --apiKey');
    process.exit(1);
  }

  // 2) Render + extract per URL
  const pages = [];
  for (const url of urls) {
    const result = await renderAndExtract(url, argv.language, cfg.tz);
    if (result) pages.push(result);
  }

  // 3) Build output
  const { header, rows } = buildHeaderAndRows(pages);

  // 4) Sheets or CSV
  if (argv.sheetId && argv.serviceAccountKey) {
    await uploadToGoogleSheet({ rows, header, sheetId: argv.sheetId, sheetName: argv.sheetName || 'Sheet1', serviceAccountKey: argv.serviceAccountKey });
  } else {
    await writeCsv('serp_headings.csv', header, rows);
  }

  // 5) Save raw JSON too (debug)
  fs.writeFileSync('headings_raw.json', JSON.stringify(pages, null, 2));
  console.log('Saved headings_raw.json');
})().catch(e => { console.error(e); process.exit(1); });
