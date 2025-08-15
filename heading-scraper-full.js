// File: headings_scraper_full_serp_features.js
// All-in-one scraper with FULL headings + SERP feature detection.
// - Unlimited H1–H6 extraction (doc + open shadow DOM + ARIA)
// - Country-wide SERP via SerpAPI (per-city sampling) with features (Featured Snippet, KP, PAA, Video, Image Pack, AI Overview)
// - Optional Playwright fallback SERP feature detector (incl. robust AI Overview probe) if SerpAPI is not available
// - Outputs:
//    * Headings table -> Google Sheet (Sheet1 by default) OR CSV
//    * SERP features summary -> Google Sheet tab "SERP_Summary" OR JSON (serp_summary.json)
//
// Install:
//   npm i playwright googleapis axios csv-writer
//
// Run (SerpAPI):
//   node headings_scraper_full_serp_features.js --query="ERP" --country="Australia" --language="en" \
//     --apiKey="YOUR_SERPAPI_API_KEY" --maxCities=6 --maxUnique=10 \
//     --sheetId="YOUR_SHEET_ID" --sheetName="Headings" --serviceAccountKey="./service_account.json"
//
// Run (direct URLs, no SerpAPI; SERP features won't be available without a SERP step, but headings still work):
//   node headings_scraper_full_serp_features.js --urls="https://example.com,https://example.org"
//
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
  out.sheetName = out.sheetName || process.env.SHEET_NAME || 'Headings';
  out.serviceAccountKey = out.serviceAccountKey || process.env.SERVICE_ACCOUNT_KEY;
  return out;
}

/** ====================== Country Config ====================== **/
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

/** ====================== SerpAPI helpers ====================== **/
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
  const urls = (data.organic_results || []).map(r => r.link).filter(Boolean);
  // Extract SERP features
  const features = {
    FeaturedSnippet: !!(data.answer_box || data.featured_snippet),
    KnowledgePanel: !!data.knowledge_graph,
    PeopleAlsoAsk: !!(data.related_questions || data.people_also_ask),
    ImagePack: !!data.inline_images,
    Video: !!(data.inline_videos || data.video_results),
    AIOverview: !!data.ai_overview
  };
  // Optional extra call to AI Overview engine if hinted but not included
  if (!features.AIOverview && (data.search_information?.ai_overview_is_available)) {
    try {
      const { data: aio } = await axios.get('https://serpapi.com/search.json', {
        params: {
          engine: 'google_ai_overview',
          q: query,
          google_domain: cfg.google_domain,
          gl: cfg.gl,
          hl: language,
          location,
          api_key: apiKey
        },
        timeout: 45000
      });
      if (aio && aio.ai_overview) features.AIOverview = true;
    } catch {}
  }
  return { urls, features };
}

/** ====================== Playwright SERP feature fallback ====================== **/
async function detectAIOverview(page) {
  let genAiNetworkSeen = false;
  const netListener = (req) => {
    const u = req.url();
    if ( /genai|searchgenai|unified_qa|\/_\/SearchGenAI|_batchexecute/i.test(u) && /google\./i.test(u) ) {
      genAiNetworkSeen = true;
    }
  };
  page.on('request', netListener);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  const AIO_LOCALIZED = [/ai overview/i, /overview from ai/i, /generated by ai/i, /ai オーバービュー/i];
  async function isVisibleEl(el) {
    return await el.evaluate((node) => {
      const s = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    });
  }
  async function domProbe() {
    const blocks = await page.locator('div, section, aside, article').elementHandles();
    for (const el of blocks) {
      const text = (await el.evaluate(n => (n.innerText || '').replace(/\s+/g,' ').trim().slice(0, 2000))).toLowerCase();
      if (!text) continue;
      if (AIO_LOCALIZED.some(rx => rx.test(text))) {
        if (await isVisibleEl(el)) return { present: true };
      }
    }
    const sources = page.locator('a[aria-label*="About this result" i], div:has-text("From the web")');
    if (await sources.count()) return { present: true };
    return { present: false };
  }
  let result = await domProbe();
  if (!result.present) {
    const observed = await page.evaluate(() => new Promise((resolve) => {
      const rx = [/ai overview/i, /overview from ai/i, /generated by ai/i];
      const timer = setTimeout(() => resolve(false), 3500);
      const obs = new MutationObserver(() => {
        const txt = document.body.innerText || '';
        if (rx.some(r => r.test(txt))) { clearTimeout(timer); obs.disconnect(); resolve(true); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }));
    if (observed) result = await domProbe();
  }
  page.off('request', netListener);
  return { AIOverview: !!result.present, AIOverviewNetwork: genAiNetworkSeen };
}
async function detectSerpFeaturesWithPlaywright({ query, cfg, language }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: language,
    timezoneId: cfg.tz,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const url = `https://www.${cfg.google_domain}/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(language)}&gl=${cfg.gl}&num=10&pws=0`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  try {
    const consent = page.locator('button:has-text("I agree"), button:has-text("Accept all"), button:has-text("Accept")').first();
    if (await consent.isVisible({ timeout: 2000 })) await consent.click();
  } catch {}
  const aio = await detectAIOverview(page);
  const features = await page.evaluate(() => ({
    FeaturedSnippet: !!document.querySelector('[data-attrid="wa:/description"], [data-attrid="kc:/webanswers:wa"]'),
    KnowledgePanel: !!document.querySelector('#kp-wp-tab-overview, [data-attrid="title"]'),
    PeopleAlsoAsk: !!document.querySelector('div[aria-label*="People also ask"], div[jsname="Cpkphb"]'),
    Video: !!document.querySelector('g-scrolling-carousel a[href*="youtube.com"], a[href*="watch?v="]'),
    ImagePack: !!document.querySelector('g-scrolling-carousel img, div[data-hveid][data-ved] img')
  }));
  features.AIOverview = aio.AIOverview;
  features.AIOverviewNetworkSignal = aio.AIOverviewNetwork;
  await context.close();
  await browser.close();
  return features;
}

/** ====================== Headings extraction (FULL) ====================== **/
async function extractMeta(page) {
  return await page.evaluate(() => {
    const metaDesc = document.querySelector('meta[name="description"]');
    return { title: document.title || '', description: metaDesc?.getAttribute('content') || '' };
  });
}
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
      if (rect.width === 0 || rect.height === 0) return;
      const text = normalize(el.innerText || el.textContent);
      if (text) out[key].push(text);
    };
    for (const root of deepRoots()) {
      ['h1','h2','h3','h4','h5','h6'].forEach(tag => root.querySelectorAll(tag).forEach(el => push(tag, el)));
    }
    for (const root of deepRoots()) {
      root.querySelectorAll('[role="heading"]').forEach(el => {
        let lv = parseInt(el.getAttribute('aria-level'),10);
        if (!Number.isFinite(lv) || lv < 1 || lv > 6) lv = 2;
        push(`h${lv}`, el);
      });
    }
    return out;
  });
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
  const robots = await page.locator('meta[content*="noindex"]').first();
  if (await robots.count()) { await context.close(); await browser.close(); return null; }
  await page.waitForLoadState('networkidle', { timeout: 20000 });
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
  const headings = await extractHeadingsNativeAndAria(page);
  await context.close();
  await browser.close();
  return { url, meta, headings };
}

/** ====================== Output builders ====================== **/
function buildHeaderAndRows(pages) {
  const maxCols = { h1:0, h2:0, h3:0, h4:0, h5:0, h6:0 };
  for (const p of pages) for (const lv of ['h1','h2','h3','h4','h5','h6']) maxCols[lv] = Math.max(maxCols[lv], p.headings[lv]?.length || 0);
  const header = [{ id:'URL', title:'URL' },{ id:'MetaTitle', title:'MetaTitle' },{ id:'MetaDescription', title:'MetaDescription' }];
  for (const lv of ['h1','h2','h3','h4','h5','h6']) for (let i=1; i<=maxCols[lv]; i++) header.push({ id: `${lv.toUpperCase()}-${i}`, title: `${lv.toUpperCase()}-${i}` });
  const rows = pages.map(p => {
    const row = { URL: p.url, MetaTitle: p.meta.title || '', MetaDescription: p.meta.description || '' };
    for (const lv of ['h1','h2','h3','h4','h5','h6']) {
      const arr = p.headings[lv] || [];
      for (let i=1; i<=maxCols[lv]; i++) row[`${lv.toUpperCase()}-${i}`] = arr[i-1] || '';
    }
    return row;
  });
  return { header, rows };
}

/** ====================== Google Sheets ====================== **/
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
  console.log(`✅ Headings uploaded to: https://docs.google.com/spreadsheets/d/${sheetId} (tab: ${sheetName})`);
}
async function uploadSerpSummaryToSheet({ summary, sheetId, serviceAccountKey }) {
  const auth = new google.auth.GoogleAuth({ keyFile: serviceAccountKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = 'SERP_Summary';
  // Clear
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `${tab}!A:ZZ` });
  // Build rows
  const header = ['City','FeaturedSnippet','KnowledgePanel','PeopleAlsoAsk','ImagePack','Video','AIOverview'];
  const values = [header];
  for (const r of summary.perCity) {
    const f = r.features || {};
    values.push([r.city, !!f.FeaturedSnippet, !!f.KnowledgePanel, !!f.PeopleAlsoAsk, !!f.ImagePack, !!f.Video, !!f.AIOverview]);
  }
  values.push([]);
  values.push(['Aggregated (count of cities where present)']);
  const agg = summary.aggregatedFeatures;
  values.push(['—', agg.FeaturedSnippet||0, agg.KnowledgePanel||0, agg.PeopleAlsoAsk||0, agg.ImagePack||0, agg.Video||0, agg.AIOverview||0]);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  console.log(`✅ SERP summary uploaded to tab: ${tab}`);
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
  const cfg = COUNTRY_CONFIG[argv.country] || { tz: 'UTC', google_domain: 'google.com', gl: 'us' };

  // 1) Gather URLs + SERP features via SerpAPI (if available)
  let urls = [];
  let serpSummary = null;

  if (argv.urls) {
    urls = argv.urls.split(',').map(s => s.trim()).filter(Boolean);
  } else if (argv.query && argv.apiKey) {
    const cities = await getTopCities(argv.country, argv.maxCities, argv.apiKey);
    const perCity = [];
    const freq = new Map();
    for (const city of cities) {
      try {
        const { urls: list, features } = await serpapiSearchCity({ query: argv.query, language: argv.language, cfg, location: city, apiKey: argv.apiKey });
        perCity.push({ city, urls: list, features });
        for (const u of list) {
          const norm = u.replace(/#.*$/, '');
          freq.set(norm, (freq.get(norm) || 0) + 1);
        }
      } catch (e) {
        console.error('City failed:', city, e.message);
      }
    }
    const ranked = [...freq.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    urls = ranked.slice(0, argv.maxUnique).map(([u]) => u);
    // Aggregate features
    const aggregatedFeatures = {};
    for (const r of perCity) for (const [k,v] of Object.entries(r.features || {})) if (v) aggregatedFeatures[k] = (aggregatedFeatures[k] || 0) + 1;
    serpSummary = { query: argv.query, country: argv.country, language: argv.language, sampledCities: cities, perCity, aggregatedFeatures, topUniqueResults: ranked.slice(0, argv.maxUnique).map(([u,f])=>({url:u,freq:f})) };
  } else if (argv.query) {
    // Playwright fallback SERP feature probe (no SerpAPI)
    const features = await detectSerpFeaturesWithPlaywright({ query: argv.query, cfg, language: argv.language });
    serpSummary = { query: argv.query, country: argv.country, language: argv.language, sampledCities: [], perCity: [{ city: '(fallback)', urls: [], features }], aggregatedFeatures: features, topUniqueResults: [] };
  } else {
    console.error('Provide --urls="comma,separated,urls" OR SerpAPI mode with --query, --country, --apiKey');
    process.exit(1);
  }

  // 2) Render + extract headings per URL
  const pages = [];
  for (const url of urls) {
    const result = await renderAndExtract(url, argv.language, cfg.tz);
    if (result) pages.push(result);
  }

  // 3) Build headings table
  const { header, rows } = buildHeaderAndRows(pages);

  // 4) Output: Sheets or CSV + SERP summary
  if (argv.sheetId && argv.serviceAccountKey) {
    await uploadToGoogleSheet({ rows, header, sheetId: argv.sheetId, sheetName: argv.sheetName, serviceAccountKey: argv.serviceAccountKey });
    if (serpSummary) await uploadSerpSummaryToSheet({ summary: serpSummary, sheetId: argv.sheetId, serviceAccountKey: argv.serviceAccountKey });
  } else {
    await writeCsv('serp_headings.csv', header, rows);
    if (serpSummary) fs.writeFileSync('serp_summary.json', JSON.stringify(serpSummary, null, 2));
  }

  console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
