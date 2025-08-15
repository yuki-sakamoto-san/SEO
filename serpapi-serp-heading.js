// File: serpapi_serp_headings_sheets.js
// Deps: npm i playwright googleapis axios
// Usage:
//   node serpapi_serp_headings_sheets.js \
//     --query="ERP" \
//     --country="Australia" \
//     --language="en" \
//     --apiKey="YOUR_SERPAPI_KEY" \
//     --sheetId="YOUR_SHEET_ID" \
//     --sheetName="Sheet1" \
//     --serviceAccountKey="./service_account.json" \
//     --maxCities=6 \
//     --maxUnique=10
//
// What this does (SerpAPI-style SERP):
// - Uses SerpAPI Google Search API for each of several major cities in the chosen country (location parameter).
// - Aggregates top 10 organic results per city -> de-dupes -> frequency ranks -> keeps top N unique URLs.
// - Renders each URL in Playwright and extracts ALL headings (H1–H6 + heading-like via computed styles & open shadow DOM).
// - Uploads the full headings table straight to the given Google Sheet tab.
// - Saves serp_summary.json locally (cities sampled, per-city features, aggregated top results).
//
// Docs referenced:
// - Locations API: https://serpapi.com/locations-api
// - Search API: https://serpapi.com/search-api  (location vs uule params; cannot be used together)
// - Organic Results: https://serpapi.com/organic-results
// - AI Overview: https://serpapi.com/ai-overview and https://serpapi.com/google-ai-overview-api

const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');
const { google } = require('googleapis');

/** ====================== CLI ====================== **/
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out.query) throw new Error('Missing --query="<search query>"');
  out.country = out.country || 'Australia';
  out.language = out.language || 'en';
  out.maxCities = parseInt(out.maxCities || '6', 10);
  out.maxUnique = parseInt(out.maxUnique || '10', 10);
  out.apiKey = out.apiKey || process.env.SERPAPI_API_KEY;
  out.sheetId = out.sheetId || process.env.SHEET_ID;
  out.sheetName = out.sheetName || process.env.SHEET_NAME || 'Sheet1';
  out.serviceAccountKey = out.serviceAccountKey || process.env.SERVICE_ACCOUNT_KEY;
  if (!out.apiKey) throw new Error('Missing --apiKey or env SERPAPI_API_KEY');
  if (!out.sheetId) throw new Error('Missing --sheetId or env SHEET_ID');
  if (!out.serviceAccountKey) throw new Error('Missing --serviceAccountKey or env SERVICE_ACCOUNT_KEY (path to JSON key)');
  return out;
}

/** ====================== Country Config ====================== **/
const COUNTRY_CONFIG = {
  'Australia': {
    gl: 'au',
    google_domain: 'google.com.au',
    tz: 'Australia/Sydney',
    fallbackCities: [
      'Sydney, New South Wales, Australia',
      'Melbourne, Victoria, Australia',
      'Brisbane, Queensland, Australia',
      'Perth, Western Australia, Australia',
      'Adelaide, South Australia, Australia',
      'Canberra, Australian Capital Territory, Australia',
      'Hobart, Tasmania, Australia',
      'Gold Coast, Queensland, Australia'
    ]
  },
  'New Zealand': {
    gl: 'nz',
    google_domain: 'google.co.nz',
    tz: 'Pacific/Auckland',
    fallbackCities: [
      'Auckland, New Zealand',
      'Wellington, New Zealand',
      'Christchurch, Canterbury, New Zealand',
      'Hamilton, Waikato, New Zealand',
      'Tauranga, Bay Of Plenty, New Zealand',
      'Dunedin, Otago, New Zealand'
    ]
  },
  'Singapore': {
    gl: 'sg',
    google_domain: 'google.com.sg',
    tz: 'Asia/Singapore',
    fallbackCities: ['Singapore, Singapore']
  },
  'Malaysia': {
    gl: 'my',
    google_domain: 'google.com.my',
    tz: 'Asia/Kuala_Lumpur',
    fallbackCities: [
      'Kuala Lumpur, Federal Territory of Kuala Lumpur, Malaysia',
      'George Town, Penang, Malaysia',
      'Johor Bahru, Johor, Malaysia',
      'Kota Kinabalu, Sabah, Malaysia',
      'Kuching, Sarawak, Malaysia'
    ]
  },
  'India': {
    gl: 'in',
    google_domain: 'google.co.in',
    tz: 'Asia/Kolkata',
    fallbackCities: [
      'Mumbai, Maharashtra, India',
      'Delhi, India',
      'Bengaluru, Karnataka, India',
      'Hyderabad, Telangana, India',
      'Chennai, Tamil Nadu, India',
      'Kolkata, West Bengal, India'
    ]
  }
};

/** ====================== SerpAPI Helpers ====================== **/
async function getTopCitiesViaLocationsAPI(country, maxCities, apiKey) {
  // Use SerpAPI Locations API to fetch locations sorted by reach; filter to cities in given country
  // Docs: https://serpapi.com/locations-api
  try {
    const url = 'https://serpapi.com/locations.json';
    const { data } = await axios.get(url, {
      params: { q: country, limit: 2000 }
    });
    const cities = (data || []).filter(loc =>
      loc && loc.type === 'City' && (loc.country_name === country || loc.country === country)
    );
    // Already sorted by reach descending per docs
    const names = cities.map(c => c.canonical_name);
    if (!names.length) throw new Error('No city results from Locations API');
    return names.slice(0, Math.max(1, maxCities));
  } catch (e) {
    // Fallback to hardcoded top cities
    const conf = COUNTRY_CONFIG[country];
    if (!conf) throw e;
    return conf.fallbackCities.slice(0, Math.max(1, maxCities));
  }
}

async function serpapiSearchCity({ query, language, countryConfig, location, apiKey }) {
  // Docs: https://serpapi.com/search-api
  const params = {
    engine: 'google',
    q: query,
    google_domain: countryConfig.google_domain,
    gl: countryConfig.gl,
    hl: language,
    location,            // location param (uses UULE internally). Do NOT use uule simultaneously.
    num: 10,
    device: 'desktop',
    no_cache: true,
    api_key: apiKey
  };
  const url = 'https://serpapi.com/search.json';
  const { data } = await axios.get(url, { params, timeout: 60000 });
  return data;
}

function extractFeaturesFromSerpapiResponse(json) {
  // Presence booleans for common features.
  return {
    FeaturedSnippet: !!(json.answer_box || json.featured_snippet),
    KnowledgePanel: !!json.knowledge_graph,
    PeopleAlsoAsk: !!(json.related_questions || json.people_also_ask),
    ImagePack: !!json.inline_images,
    Video: !!(json.inline_videos || json.video_results),
    AIOverview: !!json.ai_overview // SerpApi includes AI Overview when present in main SERP
  };
}

/** ====================== Playwright Helpers ====================== **/
async function humanScroll(page) {
  await page.evaluate(async () => {
    await new Promise(res => {
      let total = 0;
      const step = 600;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          setTimeout(res, 400);
        }
      }, 80);
    });
  });
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

async function extractMeta(page) {
  return await page.evaluate(() => {
    const metaDesc = document.querySelector('meta[name="description"]');
    return {
      title: document.title || '',
      description: metaDesc?.getAttribute('content') || ''
    };
  });
}

async function extractHeadings(page) {
  return await page.evaluate(() => {
    function* deepElements(root=document) {
      const walker = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        yield node;
        if (node.shadowRoot && node.shadowRoot.mode === 'open') {
          yield* deepElements(node.shadowRoot);
        }
      }
    }
    function visible(el, styles) {
      const rect = el.getBoundingClientRect();
      if (rect.height === 0 || rect.width === 0) return false;
      const disp = styles.getPropertyValue('display');
      const vis = styles.getPropertyValue('visibility');
      return disp !== 'none' && vis !== 'hidden';
    }
    function isHeadingLike(el, styles) {
      const fontWeight = styles.getPropertyValue('font-weight');
      const weightNum = parseInt(fontWeight, 10);
      const sizePx = parseFloat(styles.getPropertyValue('font-size')) || 0;
      const heavy = (Number.isFinite(weightNum) ? weightNum >= 600 : ['bold','bolder'].includes(fontWeight));
      const big = sizePx >= 18;
      const idClass = (el.id + ' ' + el.className).toLowerCase();
      const semantic = el.getAttribute('role') === 'heading' ||
        idClass.includes('title') || idClass.includes('heading') ||
        idClass.includes('headline') || idClass.includes('section-title');
      const role = (el.getAttribute('role') || '').toLowerCase();
      const inNav = role === 'navigation';
      return !inNav && (semantic || (heavy && big));
    }
    const headings = [];
    const seen = new Set();
    for (const el of deepElements()) {
      const tag = el.tagName?.toLowerCase();
      const styles = getComputedStyle(el);
      if (!visible(el, styles)) continue;
      let level = null;
      if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
        level = parseInt(tag[1], 10);
      } else if (isHeadingLike(el, styles)) {
        const size = parseFloat(styles.getPropertyValue('font-size')) || 0;
        if (size >= 30) level = 1;
        else if (size >= 24) level = 2;
        else if (size >= 20) level = 3;
        else if (size >= 18) level = 4;
        else level = 5;
      }
      if (level) {
        let text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const rect = el.getBoundingClientRect();
        const key = `${level}::${text}::${Math.round(rect.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        headings.push({ level, text, y: rect.y });
      }
    }
    headings.sort((a,b) => a.y - b.y);
    return headings;
  });
}

async function renderAndExtract({ browser, language, tz, url }) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: language,
    timezoneId: tz,
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
  if (!ok) { await context.close(); return null; }

  const robots = await page.locator('meta[content*="noindex"]').first();
  if (await robots.count()) { await context.close(); return null; }

  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.waitForTimeout(1800);
  await humanScroll(page);

  let meta = await extractMeta(page);
  let heads = await extractHeadings(page);
  if (heads.length < 6) {
    await page.waitForTimeout(5000);
    await humanScroll(page);
    const meta2 = await extractMeta(page);
    const heads2 = await extractHeadings(page);
    if (heads2.length > heads.length) { meta = meta2; heads = heads2; }
  }
  const grouped = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const h of heads) {
    const lv = Math.min(Math.max(h.level,1),6);
    grouped[lv].push(h.text);
  }
  await context.close();
  return { url, meta, grouped };
}

/** ============ Google Sheets Upload ============ **/
async function uploadToGoogleSheet({ rows, header, sheetId, sheetName, serviceAccountKey }) {
  const auth = new google.auth.GoogleAuth({
    keyFile: serviceAccountKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const headerTitles = header.map(h => h.title);
  const values = [headerTitles];
  for (const r of rows) {
    values.push(header.map(h => r[h.id] ?? ''));
  }

  // Clear range before writing
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:ZZ`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
  console.log(`✅ Uploaded to Google Sheet: https://docs.google.com/spreadsheets/d/${sheetId} (tab: ${sheetName})`);
}

/** ====================== Main ====================== **/
(async () => {
  const { query, country, language, maxCities, maxUnique, apiKey, sheetId, sheetName, serviceAccountKey } = parseArgs();
  const cfg = COUNTRY_CONFIG[country];
  if (!cfg) {
    console.error(`Unsupported country "${country}". Supported: ${Object.keys(COUNTRY_CONFIG).join(', ')}`);
    process.exit(1);
  }

  // 1) Get top cities (Locations API -> fallback list)
  const cities = await getTopCitiesViaLocationsAPI(country, maxCities, apiKey);

  // 2) Query SerpAPI per city
  const perCity = [];
  for (const loc of cities) {
    try {
      const json = await serpapiSearchCity({ query, language, countryConfig: cfg, location: loc, apiKey });
      const organic = (json.organic_results || []).map(r => r.link).filter(Boolean);
      const feats = extractFeaturesFromSerpapiResponse(json);

      // If AIO sometimes requires separate request
      if (!feats.AIOverview && (json.search_information?.ai_overview_is_available)) {
        try {
          const { data: aio } = await axios.get('https://serpapi.com/search.json', {
            params: {
              engine: 'google_ai_overview',
              q: query,
              google_domain: cfg.google_domain,
              gl: cfg.gl,
              hl: language,
              location: loc,
              api_key: apiKey
            },
            timeout: 45000
          });
          if (aio && aio.ai_overview) feats.AIOverview = true;
        } catch {}
      }

      perCity.push({ city: loc, urls: organic.slice(0,10), features: feats });
    } catch (e) {
      console.error(`City failed: ${loc}: ${e.message}`);
    }
  }

  // 3) Aggregate URLs by frequency across cities
  const urlFreq = new Map();
  for (const r of perCity) {
    for (const u of (r?.urls || [])) {
      const norm = u.replace(/#.*$/, '');
      urlFreq.set(norm, (urlFreq.get(norm) || 0) + 1);
    }
  }
  const ranked = [...urlFreq.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topUnique = ranked.slice(0, maxUnique).map(([u, f]) => ({ url: u, freq: f }));

  // 4) Render each unique URL and extract headings/meta
  const browser = await chromium.launch({ headless: true });
  const pageData = [];
  for (const item of topUnique) {
    const row = await renderAndExtract({ browser, language, tz: cfg.tz, url: item.url });
    if (row) pageData.push(row);
  }
  await browser.close();

  // 5) Build Google Sheet header dynamically from max per level
  const maxCols = {1:0,2:0,3:0,4:0,5:0,6:0};
  for (const row of pageData) {
    for (let lv=1; lv<=6; lv++) {
      maxCols[lv] = Math.max(maxCols[lv], row.grouped[lv].length);
    }
  }
  const header = [
    {id:'URL', title:'URL'},
    {id:'MetaTitle', title:'MetaTitle'},
    {id:'MetaDescription', title:'MetaDescription'},
  ];
  for (let lv=1; lv<=6; lv++) {
    for (let i=1; i<=maxCols[lv]; i++) {
      header.push({ id: `H${lv}-${i}`, title: `H${lv}-${i}` });
    }
  }
  const rows = pageData.map(row => {
    const base = {
      URL: row.url,
      MetaTitle: row.meta.title,
      MetaDescription: row.meta.description,
    };
    for (let lv=1; lv<=6; lv++) {
      const list = row.grouped[lv];
      for (let i=1; i<=maxCols[lv]; i++) {
        base[`H${lv}-${i}`] = list[i-1] || '';
      }
    }
    return base;
  });

  // 6) Upload to Google Sheets
  await uploadToGoogleSheet({ rows, header, sheetId, sheetName, serviceAccountKey });

  // 7) Write SERP summary JSON
  const featureAgg = {};
  for (const r of perCity) {
    if (!r) continue;
    for (const [k,v] of Object.entries(r.features || {})) {
      if (v) featureAgg[k] = (featureAgg[k] || 0) + 1;
    }
  }
  const summary = {
    query,
    country,
    language,
    sampledCities: cities,
    perCity,
    aggregatedFeatures: featureAgg,
    topUniqueResults: topUnique
  };
  fs.writeFileSync('serp_summary.json', JSON.stringify(summary, null, 2));
  console.log('Saved serp_summary.json');
})().catch(e => { console.error(e); process.exit(1); });
