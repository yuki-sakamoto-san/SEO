// File: headings_scraper_single_location_v5.js
// Single-location SERP with **SerpAPI parity** + worldwide support + robust AIO + full headings.
//
// Highlights:
// - **Parity-first**: preserves SerpAPI top-N order and uses SerpAPI's **google_url** to verify features on HTML (no hand-rolled UULE)
// - **Worldwide**: pass --country OR explicit google_domain/gl/hl/location (JP/FR/DE/etc.).
// - **AIO**: reads multiple SerpAPI fields, **always probes google_ai_overview** (opt-in), and verifies on HTML with network + localized text hints.
// - **Headings**: unlimited H1–H6 (native + ARIA), heading-like fallbacks, same-origin iframes, includeHidden, retries, extra waits/scroll.
// - **Sheets**: writes Headings + SERP_Summary. CSV/JSON fallback.
//
// Install: npm i playwright googleapis axios csv-writer
//
// Example (Australia):
// node headings_scraper_single_location_v5.js \
//   --query="3D secure" --country="Australia" --location="Australia" \
//   --apiKey="YOUR_SERPAPI_KEY" \
//   --sheetId="YOUR_SHEET_ID" --sheetName="Headings" --serviceAccountKey="./service_account.json" \
//   --verifySerpWithPlaywright=true --aioProbeAlways=true --aioProbeHlFallback=en \
//   --includeHidden=true --headingLike=true --respectNoindex=false \
//   --num=10 --safe=active
//
// Example (Japan):
// node ... --country="Japan" --location="Japan" --hl="ja" --num=10 --safe=active
//
// Example (France):
// node ... --country="France" --location="France" --hl="fr" --num=10
//
// Example (Germany):
// node ... --country="Germany" --location="Germany" --hl="de" --num=10
//
const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');
const { google } = require('googleapis');
const { createObjectCsvWriter } = require('csv-writer');

/** ====================== COUNTRY PRESETS ====================== **/
const PRESETS = {
  "Australia":   { google_domain: "google.com.au", gl: "au", hl: "en" },
  "New Zealand": { google_domain: "google.co.nz", gl: "nz", hl: "en" },
  "Singapore":   { google_domain: "google.com.sg", gl: "sg", hl: "en" },
  "Malaysia":    { google_domain: "google.com.my", gl: "my", hl: "en" },
  "India":       { google_domain: "google.co.in", gl: "in", hl: "en" },
  "Japan":       { google_domain: "google.co.jp", gl: "jp", hl: "ja" },
  "France":      { google_domain: "google.fr",    gl: "fr", hl: "fr" },
  "Germany":     { google_domain: "google.de",    gl: "de", hl: "de" },
  "United Kingdom": { google_domain: "google.co.uk", gl: "gb", hl: "en" },
  "United States":  { google_domain: "google.com",   gl: "us", hl: "en" },
  "Canada":         { google_domain: "google.ca",    gl: "ca", hl: "en" },
  "Ireland":        { google_domain: "google.ie",    gl: "ie", hl: "en" },
  "Spain":          { google_domain: "google.es",    gl: "es", hl: "es" },
  "Italy":          { google_domain: "google.it",    gl: "it", hl: "it" },
  "Netherlands":    { google_domain: "google.nl",    gl: "nl", hl: "nl" },
  "Sweden":         { google_domain: "google.se",    gl: "se", hl: "sv" },
  "Norway":         { google_domain: "google.no",    gl: "no", hl: "no" },
  "Denmark":        { google_domain: "google.dk",    gl: "dk", hl: "da" },
  "Finland":        { google_domain: "google.fi",    gl: "fi", hl: "fi" },
  "Austria":        { google_domain: "google.at",    gl: "at", hl: "de" },
  "Switzerland":    { google_domain: "google.ch",    gl: "ch", hl: "de" },
  "Belgium":        { google_domain: "google.be",    gl: "be", hl: "fr" }
};

/** ====================== CLI ====================== **/
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out.query) throw new Error('Missing --query');
  // Optional: apply preset
  if (out.country && PRESETS[out.country]) {
    const p = PRESETS[out.country];
    out.google_domain = out.google_domain || p.google_domain;
    out.gl = out.gl || p.gl;
    out.hl = out.hl || p.hl;
  }
  if (!out.location) throw new Error('Missing --location (e.g., "Australia", "Japan", or a city string)');
  out.google_domain = out.google_domain || 'google.com';
  out.gl = out.gl || 'us';
  out.hl = out.hl || 'en';
  if (!out.apiKey) throw new Error('Missing --apiKey');
  out.num = Math.min(100, parseInt(out.num || '10', 10)); // allow up to 100
  out.safe = out.safe || 'off'; // 'active' | 'off'
  out.lr = out.lr || ''; // optional language restrict (e.g., lang_ja)
  out.sheetId = out.sheetId || process.env.SHEET_ID;
  out.sheetName = out.sheetName || process.env.SHEET_NAME || 'Headings';
  out.serviceAccountKey = out.serviceAccountKey || process.env.SERVICE_ACCOUNT_KEY;
  out.maxUnique = parseInt(out.maxUnique || String(out.num), 10);
  out.verifySerpWithPlaywright = String(out.verifySerpWithPlaywright || 'false').toLowerCase() === 'true';
  out.featuresSource = (out.featuresSource || 'both'); // 'serpapi' | 'html' | 'both'
  out.aioProbeAlways = String(out.aioProbeAlways || 'false').toLowerCase() === 'true';
  out.aioProbeHlFallback = out.aioProbeHlFallback || 'en';
  out.includeHidden = String(out.includeHidden || 'true').toLowerCase() === 'true';
  out.headingLike = String(out.headingLike || 'true').toLowerCase() === 'true';
  out.respectNoindex = String(out.respectNoindex || 'false').toLowerCase() === 'true';
  out.extraWaitMs = parseInt(out.extraWaitMs || '2000', 10);
  out.scrollSteps = parseInt(out.scrollSteps || '16', 10);
  out.scrollStepPx = parseInt(out.scrollStepPx || '950', 10);
  out.retryIfFewHeadings = parseInt(out.retryIfFewHeadings || '2', 10);
  return out;
}

/** ====================== Helpers ====================== **/
function hasAioInSerpapiData(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.ai_overview && Object.keys(d.ai_overview).length) return true;
  if (d.ai_overview_results && Object.keys(d.ai_overview_results).length) return true;
  if (d.search_information && (d.search_information.ai_overview || d.search_information.ai_overview_is_available)) return true;
  if (d.knowledge_graph && d.knowledge_graph.ai_overview) return true;
  return false;
}

const AIO_TEXT_PATTERNS = [
  /ai overview/i,
  /overview from ai/i,
  /generated by ai/i,
  // French
  /aperçu (?:par|de) l['’]ia/i, /généré par l['’]ia/i, /vue d['’]ensemble de l['’]ia/i,
  // German
  /ki[- ]?(?:übersicht|überblick)/i, /durch ki erstellt/i, /von ki generiert/i,
  // Japanese (heuristic)
  /ai[ 　]?概要/i, /ai[ 　]?による概要/i, /ai[ 　]?によって生成/i,
  // Spanish
  /resumen de ia/i, /descripción general de ia/i, /generado por ia/i,
  // Italian
  /panoramica (?:ia|dell['’]ia)/i, /generat[ao] dall['’]ia/i,
  // Dutch
  /ai[- ]?overzicht/i, /gegenereerd door ai/i
];

/** ====================== SerpAPI ====================== **/
async function serpapiSingle({ query, location, google_domain, gl, hl, apiKey, num, safe, lr, aioProbeAlways, aioProbeHlFallback }) {
  const params = {
    engine: 'google',
    q: query,
    location,
    google_domain,
    gl,
    hl,
    num,
    device: 'desktop',
    safe,
    no_cache: true,
    api_key: apiKey
  };
  if (lr) params.lr = lr;
  const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 60000 });
  const urls = (data.organic_results || []).map(r => r.link).filter(Boolean);
  const features = {
    FeaturedSnippet: !!(data.answer_box || data.featured_snippet),
    KnowledgePanel: !!data.knowledge_graph,
    PeopleAlsoAsk: !!(data.related_questions || data.people_also_ask),
    ImagePack: !!data.inline_images,
    Video: !!(data.inline_videos || data.video_results),
    AIOverview: hasAioInSerpapiData(data)
  };
  let aioProbeUsed = false;
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
      aioProbeUsed = true;
    } catch {}
  }
  const google_url = data?.search_metadata?.google_url || null;
  return { urls, features, raw: data, google_url, aioProbeUsed };
}

/** ====================== HTML verify (optional) ====================== **/
async function verifyOnHtml({ query, google_url, google_domain, gl, hl, location, extraWaitMs }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: hl,
    extraHTTPHeaders: { 'Accept-Language': hl },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const url = google_url || `https://www.${google_domain}/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(hl)}&gl=${gl}&num=10&pws=0`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  try {
    const consent = page.locator('button:has-text("I agree"), button:has-text("Accept all"), button:has-text("Accept")').first();
    if (await consent.isVisible({ timeout: 2000 })) await consent.click();
  } catch {}

  let genAiNetworkSeen = false;
  page.on('request', req => {
    const u = req.url();
    if (/genai|searchgenai|unified_qa|\/_\/SearchGenAI|_batchexecute/i.test(u) && /google\./i.test(u)) genAiNetworkSeen = true;
  });

  await page.evaluate(async () => {
    await new Promise(res => {
      let y = 0, dir = 1, steps = 0;
      const step = () => {
        window.scrollBy(0, 700 * dir);
        y += 700 * dir;
        steps++;
        if (y > 2800) dir = -1;
        if (steps < 14) setTimeout(step, 160);
        else res();
      };
      step();
    });
  });
  if (extraWaitMs) await page.waitForTimeout(parseInt(extraWaitMs,10));

  const features = await page.evaluate((AIO_RX_SRC) => {
    const AIO_RX = AIO_RX_SRC.map(s => new RegExp(s.source, s.flags));
    const textHasAio = () => {
      const t = (document.body.innerText || '').toLowerCase();
      return AIO_RX.some(r => r.test(t));
    };
    return {
      FeaturedSnippet: !!document.querySelector('[data-attrid="wa:/description"], [data-attrid="kc:/webanswers:wa"]'),
      KnowledgePanel: !!document.querySelector('#kp-wp-tab-overview, [data-attrid="title"]'),
      PeopleAlsoAsk: !!document.querySelector('div[aria-label*="People also ask"], div[jsname="Cpkphb"]'),
      Video: !!document.querySelector('g-scrolling-carousel a[href*="youtube.com"], a[href*="watch?v="]'),
      ImagePack: !!document.querySelector('g-scrolling-carousel img, div[data-hveid][data-ved] img'),
      AIOverviewLabel: !!document.querySelector('div[aria-label*="AI Overview" i], div[aria-label*="Overview from AI" i]'),
      AIOverviewText: textHasAio()
    };
  }, AIO_TEXT_PATTERNS);

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
async function extractHeadingsInFrame(frame, opts) {
  return await frame.evaluate(({ includeHidden, headingLike }) => {
    function normalize(t){ return (t || '').replace(/\s+/g,' ').trim(); }
    function visible(el) {
      if (includeHidden) return true;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    }
    function* deepRoots(root = document) {
      yield root;
      const walker = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.shadowRoot && node.shadowRoot.mode === 'open') yield* deepRoots(node.shadowRoot);
      }
    }
    const out = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
    const seen = new Set();
    const push = (key, el) => {
      if (!visible(el)) return;
      const text = normalize(el.innerText || el.textContent);
      if (!text) return;
      const sig = key + '|' + text;
      if (seen.has(sig)) return;
      seen.add(sig);
      out[key].push(text);
    };
    for (const root of deepRoots()) ['h1','h2','h3','h4','h5','h6'].forEach(tag => root.querySelectorAll(tag).forEach(el => push(tag, el)));
    for (const root of deepRoots()) root.querySelectorAll('[role="heading"]').forEach(el => {
      let lv = parseInt(el.getAttribute('aria-level'),10);
      if (!Number.isFinite(lv) || lv < 1 || lv > 6) lv = 2;
      push(`h${lv}`, el);
    });
    if (headingLike) {
      for (const root of deepRoots()) {
        const walker = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          const el = node;
          if (['H1','H2','H3','H4','H5','H6'].includes(el.tagName)) continue;
          const cs = getComputedStyle(el);
          const fwRaw = cs.getPropertyValue('font-weight');
          const fw = parseInt(fwRaw,10);
          const heavy = Number.isFinite(fw) ? fw >= 600 : /bold|bolder/i.test(fwRaw);
          const size = parseFloat(cs.getPropertyValue('font-size')) || 0;
          const idc = (el.id + ' ' + el.className).toLowerCase();
          const semantic = /title|heading|headline|section-title/.test(idc);
          if (!(heavy && size >= 18) && !semantic) continue;
          let lv = 5;
          if (size >= 30) lv = 1;
          else if (size >= 24) lv = 2;
          else if (size >= 20) lv = 3;
          else if (size >= 18) lv = 4;
          push(`h${lv}`, el);
        }
      }
    }
    return out;
  }, opts);
}

function mergeHeadings(a, b) {
  const out = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
  for (const k of Object.keys(out)) out[k] = [...(a[k]||[]), ...(b[k]||[])];
  return out;
}

async function renderAndExtract(url, hl, opts) {
  const { extraWaitMs, scrollSteps, scrollStepPx, includeHidden, headingLike, respectNoindex, retryIfFewHeadings } = opts;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: hl,
    extraHTTPHeaders: { 'Accept-Language': hl, Referer: 'https://www.google.com/' },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const headers = { ...route.request().headers(), Referer: 'https://www.google.com/', 'Accept-Language': hl };
    route.continue({ headers });
  });
  let ok = false;
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    const status = resp ? resp.status() : 0;
    if (status && status < 400) ok = true;
  } catch {}
  if (!ok) { await context.close(); await browser.close(); return null; }

  if (respectNoindex) {
    const robots = await page.locator('meta[content*="noindex" i]').first();
    if (await robots.count()) { await context.close(); await browser.close(); return null; }
  }

  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.evaluate(async ({ scrollSteps, scrollStepPx }) => {
    await new Promise(res => {
      let steps = 0;
      const step = () => {
        window.scrollBy(0, scrollStepPx);
        steps++;
        if (steps < scrollSteps) setTimeout(step, 110);
        else res();
      };
      step();
    });
  }, { scrollSteps, scrollStepPx });
  if (extraWaitMs) await page.waitForTimeout(extraWaitMs);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  // Main + same-origin iframes
  const frames = page.frames();
  let merged = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
  const frameDebug = [];
  for (const f of frames) {
    try {
      const sameOrigin = await f.evaluate(() => true);
      if (!sameOrigin) continue;
      const h = await extractHeadingsInFrame(f, { includeHidden, headingLike });
      frameDebug.push({ url: f.url(), counts: { h1: h.h1.length, h2: h.h2.length, h3: h.h3.length, h4: h.h4.length, h5: h.h5.length, h6: h.h6.length } });
      merged = mergeHeadings(merged, h);
    } catch {}
  }

  const total = merged.h1.length + merged.h2.length + merged.h3.length + merged.h4.length + merged.h5.length + merged.h6.length;
  if (total < retryIfFewHeadings) {
    await page.evaluate(async ({ scrollSteps, scrollStepPx }) => {
      await new Promise(res => {
        let steps = 0;
        const step = () => {
          window.scrollBy(0, scrollStepPx);
          steps++;
          if (steps < Math.max(10, Math.floor(scrollSteps * 1.2))) setTimeout(step, 140);
          else res();
        };
        step();
      });
    }, { scrollSteps, scrollStepPx });
    await page.waitForTimeout(extraWaitMs + 500);
    try {
      const h2 = await extractHeadingsInFrame(page.mainFrame(), { includeHidden, headingLike });
      frameDebug.push({ url: page.url(), counts_retry: { h1: h2.h1.length, h2: h2.h2.length, h3: h2.h3.length, h4: h2.h4.length, h5: h2.h5.length, h6: h2.h6.length } });
      merged = mergeHeadings(merged, h2);
    } catch {}
  }

  const meta = await page.evaluate(() => {
    const metaDesc = document.querySelector('meta[name="description"]');
    return { title: document.title || '', description: metaDesc?.getAttribute('content') || '' };
  });

  await context.close();
  await browser.close();
  return { url, meta, headings: merged, frameDebug };
}

/** ====================== Output ====================== **/
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
  return { header, rows, maxCols };
}

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
  const header = ['Source','Location','TopN','FeaturedSnippet','KnowledgePanel','PeopleAlsoAsk','ImagePack','Video','AIOverview','Signals','GoogleURL','AioProbeUsed'];
  const values = [header];
  const f = summary.features || {};
  values.push(['SerpAPI', summary.location, summary.num, !!f.FeaturedSnippet, !!f.KnowledgePanel, !!f.PeopleAlsoAsk, !!f.ImagePack, !!f.Video, !!f.AIOverview, '—', summary.google_url || '—', summary.aioProbeUsed || false]);
  if (summary.verify) {
    const v = summary.verify.features;
    values.push([]);
    values.push(['HTML', summary.location, summary.num, !!v.FeaturedSnippet, !!v.KnowledgePanel, !!v.PeopleAlsoAsk, !!v.ImagePack, !!v.Video, !!v.AIOverview, JSON.stringify(v.Signals || {}), summary.verify.url, '—']);
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  console.log(`✅ SERP summary uploaded to tab: ${tab}`);
}

async function writeCsv(path, header, rows) {
  const csvWriter = createObjectCsvWriter({ path, header });
  await csvWriter.writeRecords(rows);
  console.log(`💾 Wrote ${path}`);
}

/** ====================== Main ====================== **/
(async () => {
  const argv = parseArgs();

  // 1) SerpAPI (single location, parity-first)
  const { urls, features, raw, google_url, aioProbeUsed } = await serpapiSingle({
    query: argv.query,
    location: argv.location,
    google_domain: argv.google_domain,
    gl: argv.gl,
    hl: argv.hl,
    apiKey: argv.apiKey,
    num: argv.num,
    safe: argv.safe,
    lr: argv.lr,
    aioProbeAlways: argv.aioProbeAlways,
    aioProbeHlFallback: argv.aioProbeHlFallback
  });

  // 2) Render + extract headings from the first maxUnique URLs
  const top = urls.slice(0, argv.maxUnique);
  const pages = [];
  const debug = [];
  for (const url of top) {
    const res = await renderAndExtract(url, argv.hl, {
      extraWaitMs: argv.extraWaitMs,
      scrollSteps: argv.scrollSteps,
      scrollStepPx: argv.scrollStepPx,
      includeHidden: argv.includeHidden,
      headingLike: argv.headingLike,
      respectNoindex: argv.respectNoindex,
      retryIfFewHeadings: argv.retryIfFewHeadings
    });
    if (res) {
      pages.push(res);
      debug.push({
        url: res.url,
        counts: {
          h1: res.headings.h1.length,
          h2: res.headings.h2.length,
          h3: res.headings.h3.length,
          h4: res.headings.h4.length,
          h5: res.headings.h5.length,
          h6: res.headings.h6.length
        },
        frames: res.frameDebug
      });
    }
  }

  const { header, rows, maxCols } = buildHeaderAndRows(pages);

  // 3) HTML verify (optional), using SerpAPI google_url for perfect parity
  let verify = null;
  if (argv.verifySerpWithPlaywright) {
    verify = await verifyOnHtml({
      query: argv.query,
      google_url,
      google_domain: argv.google_domain,
      gl: argv.gl,
      hl: argv.hl,
      location: argv.location,
      extraWaitMs: argv.extraWaitMs
    });
  }

  // 4) Output
  const summary = {
    query: argv.query,
    location: argv.location,
    google_domain: argv.google_domain,
    gl: argv.gl,
    hl: argv.hl,
    num: argv.num,
    features,
    verify,
    google_url,
    aioProbeUsed,
    raw_sample: raw?.search_metadata ? {
      google_url: raw.search_metadata.google_url,
      created_at: raw.search_metadata.created_at
    } : null,
    heading_max_cols: maxCols
  };

  // Debug
  fs.writeFileSync('headings_debug.json', JSON.stringify({ pages: debug, maxCols }, null, 2));

  if (argv.sheetId && argv.serviceAccountKey) {
    await uploadToGoogleSheet({ rows, header, sheetId: argv.sheetId, sheetName: argv.sheetName, serviceAccountKey: argv.serviceAccountKey });
    await uploadSerpSummaryToSheet({ summary, sheetId: argv.sheetId, serviceAccountKey: argv.serviceAccountKey });
  } else {
    await writeCsv('serp_headings.csv', header, rows);
    fs.writeFileSync('serp_summary.json', JSON.stringify(summary, null, 2));
  }

  console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
