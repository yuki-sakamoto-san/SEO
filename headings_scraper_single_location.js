// Purpose: Exactly reproduce a single SerpAPI location SERP (e.g., "Australia") with preserved top-10 order,
//          detect SERP features (incl. AI Overview & Knowledge Panel), render each URL, and extract ALL H1–H6.
//          No city aggregation, no mixing locales.
// Install:  npm i playwright googleapis axios csv-writer
//
// Example (matches your JSON):
// node headings_scraper_single_location.js \
//   --query="Chargeback" \
//   --location="Australia" \
//   --google_domain="google.com.au" \
//   --gl="au" \
//   --hl="en" \
//   --apiKey="YOUR_SERPAPI_KEY" \
//   --sheetId="YOUR_SHEET_ID" \
//   --sheetName="Headings" \
//   --serviceAccountKey="./service_account.json" \
//   --verifySerpWithPlaywright=true
//
// Optional: if you want to verify features on the HTML SERP itself, keep --verifySerpWithPlaywright=true (uses UULE built from --location).

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
  return out;
}

/** ====================== SerpAPI single-location ====================== **/
async function serpapiSingle({ query, location, google_domain, gl, hl, apiKey }) {
  const params = {
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
  const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 60000 });
  const urls = (data.organic_results || []).map(r => r.link).filter(Boolean); // preserve order
  const features = {
    FeaturedSnippet: !!(data.answer_box || data.featured_snippet),
    KnowledgePanel: !!data.knowledge_graph,
    PeopleAlsoAsk: !!(data.related_questions || data.people_also_ask),
    ImagePack: !!data.inline_images,
    Video: !!(data.inline_videos || data.video_results),
    AIOverview: !!data.ai_overview
  };
  // If AI Overview may be available but not embedded, probe AI Overview engine
  if (!features.AIOverview && (data.search_information?.ai_overview_is_available)) {
    try {
      const { data: aio } = await axios.get('https://serpapi.com/search.json', {
        params: {
          engine: 'google_ai_overview',
          q: query,
          google_domain,
          gl,
          hl,
          location,
          api_key: apiKey
        },
        timeout: 45000
      });
      if (aio && aio.ai_overview) features.AIOverview = true;
    } catch {}
  }
  return { urls, features, raw: data };
}

/** ====================== Verify on Google HTML (optional) ====================== **/
function buildUule(loc) {
  // Build a simple UULE from location text
  const b64 = Buffer.from(loc, 'utf8').toString('base64');
  return `w+CAIQICI${b64}`; // matches the pattern in your pasted URL
}
async function verifySerpOnGoogleHtml({ query, location, google_domain, gl, hl }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: hl,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const uule = buildUule(location);
  const url = `https://www.${google_domain}/search?q=${encodeURIComponent(query)}&oq=${encodeURIComponent(query)}&uule=${encodeURIComponent(uule)}&hl=${encodeURIComponent(hl)}&gl=${gl}&num=10&pws=0`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  try {
    const consent = page.locator('button:has-text("I agree"), button:has-text("Accept all"), button:has-text("Accept")').first();
    if (await consent.isVisible({ timeout: 1500 })) await consent.click();
  } catch {}
  let genAiNetworkSeen = false;
  page.on('request', req => {
    const u = req.url();
    if ( /genai|searchgenai|unified_qa|\/_\/SearchGenAI|_batchexecute/i.test(u) && /google\./i.test(u) ) genAiNetworkSeen = true;
  });
  await page.waitForTimeout(1200);
  const features = await page.evaluate(() => ({
    FeaturedSnippet: !!document.querySelector('[data-attrid="wa:/description"], [data-attrid="kc:/webanswers:wa"]'),
    KnowledgePanel: !!document.querySelector('#kp-wp-tab-overview, [data-attrid="title"]'),
    PeopleAlsoAsk: !!document.querySelector('div[aria-label*="People also ask"], div[jsname="Cpkphb"]'),
    Video: !!document.querySelector('g-scrolling-carousel a[href*="youtube.com"], a[href*="watch?v="]'),
    ImagePack: !!document.querySelector('g-scrolling-carousel img, div[data-hveid][data-ved] img'),
    AIOverviewLabel: !!document.querySelector('div[aria-label*="AI Overview" i]')
  }));
  const textHasAIO = await page.evaluate(() => {
    const rx = [/ai overview/i, /overview from ai/i, /generated by ai/i];
    const t = (document.body.innerText || '').toLowerCase();
    return rx.some(r => r.test(t));
  });
  const out = {
    FeaturedSnippet: features.FeaturedSnippet,
    KnowledgePanel: features.KnowledgePanel,
    PeopleAlsoAsk: features.PeopleAlsoAsk,
    Video: features.Video,
    ImagePack: features.ImagePack,
    AIOverview: features.AIOverviewLabel || textHasAIO || genAiNetworkSeen
  };
  await context.close();
  await browser.close();
  return { url, features: out, aiNetwork: genAiNetworkSeen };
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
  // simple long scroll to materialize lazy content
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
  const header = ['Source','Location','FeaturedSnippet','KnowledgePanel','PeopleAlsoAsk','ImagePack','Video','AIOverview'];
  const values = [header];
  const f = summary.features || {};
  values.push(['SerpAPI', summary.location, !!f.FeaturedSnippet, !!f.KnowledgePanel, !!f.PeopleAlsoAsk, !!f.ImagePack, !!f.Video, !!f.AIOverview]);
  if (summary.verify) {
    const v = summary.verify.features;
    values.push([]);
    values.push(['Playwright', summary.location, !!v.FeaturedSnippet, !!v.KnowledgePanel, !!v.PeopleAlsoAsk, !!v.ImagePack, !!v.Video, !!v.AIOverview]);
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
  const { urls, features, raw } = await serpapiSingle({
    query: argv.query, location: argv.location, google_domain: argv.google_domain, gl: argv.gl, hl: argv.hl, apiKey: argv.apiKey
  });

  // Keep returned order, trim to maxUnique
  const top = urls.slice(0, argv.maxUnique);
  const pages = [];
  for (const url of top) {
    const res = await renderAndExtract(url, argv.hl);
    if (res) pages.push(res);
  }

  const { header, rows } = buildHeaderAndRows(pages);

  let verify = null;
  if (argv.verifySerpWithPlaywright) {
    verify = await verifySerpOnGoogleHtml({
      query: argv.query, location: argv.location, google_domain: argv.google_domain, gl: argv.gl, hl: argv.hl
    });
  }

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
