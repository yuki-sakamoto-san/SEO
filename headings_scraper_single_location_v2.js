// File: headings_scraper_single_location_v2.js
// Single-location SERP (no aggregation) + robust AI Overview detection.
//
// Changelog vs v1:
//  - Detects AIO via multiple fields (ai_overview, ai_overview_results, search_information.ai_overview_is_available)
//  - Adds --aioProbeAlways=true to ALWAYS call google_ai_overview engine for confirmation
//  - Adds --aioProbeHlFallback=en to force hl=en ONLY for the AIO probe if your main hl isn't 'en'
//  - Improves Playwright HTML verification (more strings + longer watch + gentle scroll)
//
// Install:  npm i playwright googleapis axios csv-writer
//
// Example:
// node headings_scraper_single_location_v2.js \
//   --query="Chargeback" \
//   --location="Australia" \
//   --google_domain="google.com.au" \
//   --gl="au" \
//   --hl="en" \
//   --apiKey="YOUR_SERPAPI_KEY" \
//   --sheetId="YOUR_SHEET_ID" \
//   --sheetName="Headings" \
//   --serviceAccountKey="./service_account.json" \
//   --verifySerpWithPlaywright=true \
//   --aioProbeAlways=true \
//   --aioProbeHlFallback=en
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
  if (!out.query) throw new Error('Missing --query');
  if (!out.location) throw new Error('Missing --location (e.g., "Australia" or "Sydney, New South Wales, Australia")');
  out.google_domain = out.google_domain || 'google.com.au';
  out.gl = out.gl || 'au';
  out.hl = out.hl || 'en';
  if (!out.apiKey) throw new Error('Missing --apiKey (SerpAPI key)');
  out.sheetId = out.sheetId || process.env.SHEET_ID;
  out.sheetName = out.sheetName || process.env.SHEET_NAME || 'Headings';
  out.serviceAccountKey = out.serviceAccountKey || process.env.SERVICE_ACCOUNT_KEY;
  out.maxUnique = parseInt(out.maxUnique || '10', 10);
  out.verifySerpWithPlaywright = String(out.verifySerpWithPlaywright || 'false').toLowerCase() === 'true';
  out.aioProbeAlways = String(out.aioProbeAlways || 'false').toLowerCase() === 'true';
  out.aioProbeHlFallback = out.aioProbeHlFallback || 'en';
  return out;
}

/** ====================== Helpers ====================== **/
function hasAioInSerpapiData(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.ai_overview && Object.keys(d.ai_overview).length) return true;
  if (d.ai_overview_results && Object.keys(d.ai_overview_results).length) return true;
  if (d.search_information && (d.search_information.ai_overview || d.search_information.ai_overview_is_available)) return true;
  // Some experiments place AIO-like data in knowledge_graph extras. Be conservative:
  if (d.knowledge_graph && d.knowledge_graph.ai_overview) return true;
  return false;
}
function buildUule(loc) {
  const b64 = Buffer.from(loc, 'utf8').toString('base64');
  return `w+CAIQICI${b64}`;
}

/** ====================== SerpAPI ====================== **/
async function serpapiSingle({ query, location, google_domain, gl, hl, apiKey, aioProbeAlways, aioProbeHlFallback }) {
  const primaryParams = {
    engine: 'google',
    q: query,
    location,
    google_domain,
    gl,
    hl,
    num: 10,
    device: 'desktop',
    no_cache: true,
    api_key: apiKey
  };
  const { data } = await axios.get('https://serpapi.com/search.json', { params: primaryParams, timeout: 60000 });
  const urls = (data.organic_results || []).map(r => r.link).filter(Boolean); // preserve order
  // Features
  const features = {
    FeaturedSnippet: !!(data.answer_box || data.featured_snippet),
    KnowledgePanel: !!data.knowledge_graph,
    PeopleAlsoAsk: !!(data.related_questions || data.people_also_ask),
    ImagePack: !!data.inline_images,
    Video: !!(data.inline_videos || data.video_results),
    AIOverview: hasAioInSerpapiData(data)
  };

  // Proactive AIO probe when needed
  if (!features.AIOverview && (aioProbeAlways || hl.toLowerCase() !== 'en')) {
    const probeParams = {
      engine: 'google_ai_overview',
      q: query,
      location,
      google_domain,
      gl,
      hl: (hl.toLowerCase() === 'en' ? 'en' : aioProbeHlFallback),
      api_key: apiKey
    };
    try {
      const { data: aio } = await axios.get('https://serpapi.com/search.json', { params: probeParams, timeout: 45000 });
      if (aio && aio.ai_overview && Object.keys(aio.ai_overview).length) features.AIOverview = true;
    } catch {}
  }
  return { urls, features, raw: data };
}

/** ====================== Verify on Google HTML (optional) ====================== **/
async function verifySerpOnGoogleHtml({ query, location, google_domain, gl, hl }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: hl,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const uule = buildUule(location);
  const url = `https://www.${google_domain}/search?q=${encodeURIComponent(query)}&uule=${encodeURIComponent(uule)}&hl=${encodeURIComponent(hl)}&gl=${gl}&num=10&pws=0`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  try {
    const consent = page.locator('button:has-text("I agree"), button:has-text("Accept all"), button:has-text("Accept")').first();
    if (await consent.isVisible({ timeout: 2000 })) await consent.click();
  } catch {}

  // GAI network signal + incremental scroll to trigger lazy AIO
  let genAiNetworkSeen = false;
  page.on('request', req => {
    const u = req.url();
    if ( /genai|searchgenai|unified_qa|\/_\/SearchGenAI|_batchexecute/i.test(u) && /google\./i.test(u) ) genAiNetworkSeen = true;
  });
  await page.evaluate(async () => {
    // gentle scroll up/down to surface dynamic blocks
    await new Promise(res => {
      let y = 0, dir = 1, steps = 0;
      const step = () => {
        window.scrollBy(0, 700 * dir);
        y += 700 * dir;
        steps++;
        if (y > 2800) dir = -1;
        if (steps < 10) setTimeout(step, 180);
        else res();
      };
      step();
    });
  });
  await page.waitForTimeout(1500);

  const AIO_STRINGS = [
    /ai overview/i,
    /overview from ai/i,
    /generated by ai/i,
    /ai overviews?/i,
    /this answer is generated/i
  ];

  const features = await page.evaluate((AIO_STRINGS_SRC) => {
    const AIO_STRINGS = AIO_STRINGS_SRC.map(s => new RegExp(s.source, s.flags));
    function hasAioText() {
      const t = (document.body.innerText || '').toLowerCase();
      return AIO_STRINGS.some(r => r.test(t));
    }
    const hasAioAria = !!document.querySelector('div[aria-label*="AI Overview" i], div[aria-label*="Overview from AI" i]');
    const featuredSnippet = !!document.querySelector('[data-attrid="wa:/description"], [data-attrid="kc:/webanswers:wa"]');
    const kp = !!document.querySelector('#kp-wp-tab-overview, [data-attrid="title"]');
    const paa = !!document.querySelector('div[aria-label*="People also ask"], div[jsname="Cpkphb"]');
    const video = !!document.querySelector('g-scrolling-carousel a[href*="youtube.com"], a[href*="watch?v="]');
    const image = !!document.querySelector('g-scrolling-carousel img, div[data-hveid][data-ved] img');
    return {
      FeaturedSnippet: featuredSnippet,
      KnowledgePanel: kp,
      PeopleAlsoAsk: paa,
      Video: video,
      ImagePack: image,
      AIOverviewLabel: hasAioAria,
      AIOverviewText: hasAioText()
    };
  }, AIO_STRINGS);

  const out = {
    FeaturedSnippet: features.FeaturedSnippet,
    KnowledgePanel: features.KnowledgePanel,
    PeopleAlsoAsk: features.PeopleAlsoAsk,
    Video: features.Video,
    ImagePack: features.ImagePack,
    AIOverview: features.AIOverviewLabel || features.AIOverviewText || genAiNetworkSeen,
    Signals: { AIOverviewLabel: features.AIOverviewLabel, AIOverviewText: features.AIOverviewText, genAiNetworkSeen }
  };

  await context.close();
  await browser.close();
  return { url, features: out };
}

/** ====================== Headings extraction ====================== **/
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
        if (node.shadowRoot && node.shadowRoot.mode === 'open') yield* deepRoots(node.shadowRoot);
      }
    }
    const out = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
    const push = (key, el) => {
      const rect = el.getBoundingClientRect?.() || { width:1, height:1 };
      if (rect.width === 0 || rect.height === 0) return;
      const text = normalize(el.innerText || el.textContent);
      if (text) out[key].push(text);
    };
    for (const root of deepRoots()) ['h1','h2','h3','h4','h5','h6'].forEach(tag => root.querySelectorAll(tag).forEach(el => push(tag, el)));
    for (const root of deepRoots()) root.querySelectorAll('[role="heading"]').forEach(el => {
      let lv = parseInt(el.getAttribute('aria-level'),10);
      if (!Number.isFinite(lv) || lv < 1 || lv > 6) lv = 2;
      push(`h${lv}`, el);
    });
    return out;
  });
}
async function renderAndExtract(url, hl) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: hl,
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
        window.scrollBy(0, 900);
        scrolled += 900;
        if (scrolled < document.body.scrollHeight + 2000) setTimeout(step, 100);
        else res();
      };
      step();
    });
  });
  await page.waitForTimeout(1000);
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
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `${tab}!A:ZZ` });
  const header = ['Source','Location','FeaturedSnippet','KnowledgePanel','PeopleAlsoAsk','ImagePack','Video','AIOverview','Signals'];
  const values = [header];
  const f = summary.features || {};
  values.push(['SerpAPI', summary.location, !!f.FeaturedSnippet, !!f.KnowledgePanel, !!f.PeopleAlsoAsk, !!f.ImagePack, !!f.Video, !!f.AIOverview, '—']);
  if (summary.verify) {
    const v = summary.verify.features;
    values.push([]);
    values.push(['Playwright', summary.location, !!v.FeaturedSnippet, !!v.KnowledgePanel, !!v.PeopleAlsoAsk, !!v.ImagePack, !!v.Video, !!v.AIOverview, JSON.stringify(v.Signals || {})]);
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  console.log(`✅ SERP summary uploaded to tab: ${tab}`);
}

/** ====================== CSV fallback ====================== **/
async function writeCsv(path, header, rows) {
  const csvWriter = createObjectCsvWriter({ path, header });
  await csvWriter.writeRecords(rows);
  console.log(`💾 Wrote ${path}`);
}

/** ====================== Main ====================== **/
(async () => {
  const argv = parseArgs();

  // 1) SerpAPI single-location
  const { urls, features, raw } = await serpapiSingle({
    query: argv.query,
    location: argv.location,
    google_domain: argv.google_domain,
    gl: argv.gl,
    hl: argv.hl,
    apiKey: argv.apiKey,
    aioProbeAlways: argv.aioProbeAlways,
    aioProbeHlFallback: argv.aioProbeHlFallback
  });

  // 2) Render + extract headings (preserve order)
  const top = urls.slice(0, argv.maxUnique);
  const pages = [];
  for (const url of top) {
    const res = await renderAndExtract(url, argv.hl);
    if (res) pages.push(res);
  }
  const { header, rows } = buildHeaderAndRows(pages);

  // 3) Optional verify on HTML
  let verify = null;
  if (argv.verifySerpWithPlaywright) {
    verify = await verifySerpOnGoogleHtml({
      query: argv.query,
      location: argv.location,
      google_domain: argv.google_domain,
      gl: argv.gl,
      hl: argv.hl
    });
  }

  // 4) Output
  const summary = {
    query: argv.query,
    location: argv.location,
    google_domain: argv.google_domain,
    gl: argv.gl,
    hl: argv.hl,
    features,
    verify,
    raw_sample: raw?.search_metadata ? {
      google_url: raw.search_metadata.google_url,
      created_at: raw.search_metadata.created_at
    } : null
  };

  if (argv.sheetId && argv.serviceAccountKey) {
    await uploadToGoogleSheet({ rows, header, sheetId: argv.sheetId, sheetName: argv.sheetName, serviceAccountKey: argv.serviceAccountKey });
    await uploadSerpSummaryToSheet({ summary, sheetId: argv.sheetId, serviceAccountKey: argv.serviceAccountKey });
  } else {
    await writeCsv('serp_headings.csv', header, rows);
    fs.writeFileSync('serp_summary.json', JSON.stringify(summary, null, 2));
  }
  console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
