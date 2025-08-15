// File: headings_scraper_single_location_v6.js
// Single-location SERP with SerpAPI parity + worldwide support (expanded presets) + robust AIO + full headings.
//
// v6 adds:
//  - Big country preset list (EU27, ME, LATAM, APAC) incl. Hong Kong, Taiwan, Korea, Thailand, Indonesia, Vietnam, Ukraine, etc.
//  - Case-insensitive preset lookup with common aliases (e.g., "UK", "UAE", "South Korea", "Czech Republic", "HongKong").
//  - Everything else from v5: AIO probes, SerpAPI google_url parity, same-origin iframe extraction, heading-like fallback, retries.
//
// Install: npm i playwright googleapis axios csv-writer
//
// Example:
// node headings_scraper_single_location_v6.js \
//   --query="3D secure" \
//   --country="Thailand" --location="Thailand" \
//   --apiKey="YOUR_SERPAPI_KEY" \
//   --verifySerpWithPlaywright=true --aioProbeAlways=true --aioProbeHlFallback=en \
//   --includeHidden=true --headingLike=true --respectNoindex=false \
//   --num=10 --safe=active
//
const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');
const { google } = require('googleapis');
const { createObjectCsvWriter } = require('csv-writer');

/** ====================== COUNTRY PRESETS ====================== **/
// NOTE: Presets are sensible defaults. You can override --hl/--gl/--google_domain explicitly.
const PRESETS = {
  // --- APAC ---
  "Australia":   { google_domain: "google.com.au", gl: "au", hl: "en" },
  "New Zealand": { google_domain: "google.co.nz", gl: "nz", hl: "en" },
  "Singapore":   { google_domain: "google.com.sg", gl: "sg", hl: "en" },
  "Malaysia":    { google_domain: "google.com.my", gl: "my", hl: "en" },
  "Indonesia":   { google_domain: "google.co.id", gl: "id", hl: "id" },
  "Thailand":    { google_domain: "google.co.th", gl: "th", hl: "th" },
  "Vietnam":     { google_domain: "google.com.vn", gl: "vn", hl: "vi" },
  "Philippines": { google_domain: "google.com.ph", gl: "ph", hl: "en" },
  "India":       { google_domain: "google.co.in", gl: "in", hl: "en" },
  "Japan":       { google_domain: "google.co.jp", gl: "jp", hl: "ja" },
  "South Korea": { google_domain: "google.co.kr", gl: "kr", hl: "ko" },
  "Korea":       { google_domain: "google.co.kr", gl: "kr", hl: "ko" },
  "Taiwan":      { google_domain: "google.com.tw", gl: "tw", hl: "zh-TW" },
  "Hong Kong":   { google_domain: "google.com.hk", gl: "hk", hl: "zh-HK" },
  "Pakistan":    { google_domain: "google.com.pk", gl: "pk", hl: "en" },
  "Bangladesh":  { google_domain: "google.com.bd", gl: "bd", hl: "en" },
  "Sri Lanka":   { google_domain: "google.lk",     gl: "lk", hl: "en" },
  "Nepal":       { google_domain: "google.com.np", gl: "np", hl: "en" },

  // --- North America ---
  "United States": { google_domain: "google.com", gl: "us", hl: "en" },
  "Canada":        { google_domain: "google.ca",  gl: "ca", hl: "en" },

  // --- Europe (EU27 + others) ---
  "United Kingdom": { google_domain: "google.co.uk", gl: "gb", hl: "en" },
  "Ireland":        { google_domain: "google.ie",    gl: "ie", hl: "en" },

  "France":      { google_domain: "google.fr", gl: "fr", hl: "fr" },
  "Germany":     { google_domain: "google.de", gl: "de", hl: "de" },
  "Netherlands": { google_domain: "google.nl", gl: "nl", hl: "nl" },
  "Belgium (French)": { google_domain: "google.be", gl: "be", hl: "fr" },
  "Belgium (Dutch)":  { google_domain: "google.be", gl: "be", hl: "nl" },
  "Spain":       { google_domain: "google.es", gl: "es", hl: "es" },
  "Portugal":    { google_domain: "google.pt", gl: "pt", hl: "pt" },
  "Italy":       { google_domain: "google.it", gl: "it", hl: "it" },
  "Poland":      { google_domain: "google.pl", gl: "pl", hl: "pl" },
  "Czechia":     { google_domain: "google.cz", gl: "cz", hl: "cs" },
  "Austria":     { google_domain: "google.at", gl: "at", hl: "de" },
  "Switzerland (German)": { google_domain: "google.ch", gl: "ch", hl: "de" },
  "Switzerland (French)": { google_domain: "google.ch", gl: "ch", hl: "fr" },
  "Switzerland (Italian)":{ google_domain: "google.ch", gl: "ch", hl: "it" },
  "Sweden":      { google_domain: "google.se", gl: "se", hl: "sv" },
  "Denmark":     { google_domain: "google.dk", gl: "dk", hl: "da" },
  "Norway":      { google_domain: "google.no", gl: "no", hl: "no" },
  "Finland":     { google_domain: "google.fi", gl: "fi", hl: "fi" },
  "Estonia":     { google_domain: "google.ee", gl: "ee", hl: "et" },
  "Latvia":      { google_domain: "google.lv", gl: "lv", hl: "lv" },
  "Lithuania":   { google_domain: "google.lt", gl: "lt", hl: "lt" },
  "Romania":     { google_domain: "google.ro", gl: "ro", hl: "ro" },
  "Bulgaria":    { google_domain: "google.bg", gl: "bg", hl: "bg" },
  "Hungary":     { google_domain: "google.hu", gl: "hu", hl: "hu" },
  "Slovakia":    { google_domain: "google.sk", gl: "sk", hl: "sk" },
  "Slovenia":    { google_domain: "google.si", gl: "si", hl: "sl" },
  "Croatia":     { google_domain: "google.hr", gl: "hr", hl: "hr" },
  "Greece":      { google_domain: "google.gr", gl: "gr", hl: "el" },
  "Cyprus":      { google_domain: "google.com.cy", gl: "cy", hl: "el" },
  "Malta":       { google_domain: "google.com.mt", gl: "mt", hl: "en" },
  "Luxembourg":  { google_domain: "google.lu", gl: "lu", hl: "fr" },
  "Iceland":     { google_domain: "google.is", gl: "is", hl: "is" },
  "Ukraine":     { google_domain: "google.com.ua", gl: "ua", hl: "uk" },

  // --- Middle East & North Africa ---
  "United Arab Emirates": { google_domain: "google.ae", gl: "ae", hl: "en" },
  "Saudi Arabia": { google_domain: "google.com.sa", gl: "sa", hl: "ar" },
  "Qatar":        { google_domain: "google.com.qa", gl: "qa", hl: "ar" },
  "Kuwait":       { google_domain: "google.com.kw", gl: "kw", hl: "ar" },
  "Bahrain":      { google_domain: "google.com.bh", gl: "bh", hl: "ar" },
  "Oman":         { google_domain: "google.com.om", gl: "om", hl: "ar" },
  "Jordan":       { google_domain: "google.jo",     gl: "jo", hl: "ar" },
  "Lebanon":      { google_domain: "google.com.lb", gl: "lb", hl: "ar" },
  "Egypt":        { google_domain: "google.com.eg", gl: "eg", hl: "ar" },
  "Israel":       { google_domain: "google.co.il",  gl: "il", hl: "he" },
  "Turkey":       { google_domain: "google.com.tr", gl: "tr", hl: "tr" },
  "Morocco":      { google_domain: "google.co.ma",  gl: "ma", hl: "ar" },
  "Tunisia":      { google_domain: "google.tn",     gl: "tn", hl: "ar" },
  "Algeria":      { google_domain: "google.dz",     gl: "dz", hl: "ar" },

  // --- Latin America ---
  "Mexico":       { google_domain: "google.com.mx", gl: "mx", hl: "es" },
  "Brazil":       { google_domain: "google.com.br", gl: "br", hl: "pt-BR" },
  "Argentina":    { google_domain: "google.com.ar", gl: "ar", hl: "es" },
  "Chile":        { google_domain: "google.cl",     gl: "cl", hl: "es" },
  "Colombia":     { google_domain: "google.com.co", gl: "co", hl: "es" },
  "Peru":         { google_domain: "google.com.pe", gl: "pe", hl: "es" },
  "Ecuador":      { google_domain: "google.com.ec", gl: "ec", hl: "es" },
  "Uruguay":      { google_domain: "google.com.uy", gl: "uy", hl: "es" },
  "Paraguay":     { google_domain: "google.com.py", gl: "py", hl: "es" },
  "Bolivia":      { google_domain: "google.com.bo", gl: "bo", hl: "es" },
  "Venezuela":    { google_domain: "google.co.ve",  gl: "ve", hl: "es" },
  "Costa Rica":   { google_domain: "google.co.cr",  gl: "cr", hl: "es" },
  "Panama":       { google_domain: "google.com.pa", gl: "pa", hl: "es" },
  "Guatemala":    { google_domain: "google.com.gt", gl: "gt", hl: "es" },
  "El Salvador":  { google_domain: "google.com.sv", gl: "sv", hl: "es" },
  "Honduras":     { google_domain: "google.hn",     gl: "hn", hl: "es" },
  "Nicaragua":    { google_domain: "google.com.ni", gl: "ni", hl: "es" },
  "Dominican Republic": { google_domain: "google.com.do", gl: "do", hl: "es" },
  "Puerto Rico":  { google_domain: "google.com.pr", gl: "pr", hl: "es" },

  // --- Africa (selected) ---
  "South Africa": { google_domain: "google.co.za", gl: "za", hl: "en" },
  "Nigeria":      { google_domain: "google.com.ng", gl: "ng", hl: "en" },
  "Kenya":        { google_domain: "google.co.ke", gl: "ke", hl: "en" }
};

const ALIASES = {
  "uk": "United Kingdom",
  "gb": "United Kingdom",
  "uae": "United Arab Emirates",
  "czech republic": "Czechia",
  "south korea": "South Korea",
  "korea": "South Korea",
  "hongkong": "Hong Kong",
  "viet nam": "Vietnam",
  "suisse (fr)": "Switzerland (French)",
  "suisse (de)": "Switzerland (German)",
  "suisse (it)": "Switzerland (Italian)",
  "switzerland (fr)": "Switzerland (French)",
  "switzerland (de)": "Switzerland (German)",
  "switzerland (it)": "Switzerland (Italian)"
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

  // Optional: apply preset (case-insensitive + aliases)
  if (out.country) {
    const key = (out.country || '').trim().toLowerCase();
    const aliasTarget = ALIASES[key];
    const matched = aliasTarget || Object.keys(PRESETS).find(k => k.toLowerCase() === key);
    if (matched && PRESETS[matched]) {
      const p = PRESETS[matched];
      out.google_domain = out.google_domain || p.google_domain;
      out.gl = out.gl || p.gl;
      out.hl = out.hl || p.hl;
    }
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
  out.featuresSource = (out.featuresSource || 'both'); // 'serpapi' | 'html' | 'both' (kept for compatibility)
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

/** ====================== AIO helpers & SerpAPI ====================== **/
function hasAioInSerpapiData(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.ai_overview && Object.keys(d.ai_overview).length) return true;
  if (d.ai_overview_results && Object.keys(d.ai_overview_results).length) return true;
  if (d.search_information && (d.search_information.ai_overview || d.search_information.ai_overview_is_available)) return true;
  if (d.knowledge_graph && d.knowledge_graph.ai_overview) return true;
  return false;
}

const AIO_TEXT_PATTERNS = [
  /ai overview/i, /overview from ai/i, /generated by ai/i,
  /aperçu (?:par|de) l['’]ia/i, /généré par l['’]ia/i, /vue d['’]ensemble de l['’]ia/i,
  /ki[- ]?(?:übersicht|überblick)/i, /durch ki erstellt/i, /von ki generiert/i,
  /ai[ 　]?概要/i, /ai[ 　]?による概要/i, /ai[ 　]?によって生成/i,
  /resumen de ia/i, /descripción general de ia/i, /generado por ia/i,
  /panoramica (?:ia|dell['’]ia)/i, /generat[ao] dall['’]ia/i,
  /ai[- ]?overzicht/i, /gegenereerd door ai/i
];

async function serpapiSingle({ query, location, google_domain, gl, hl, apiKey, num, safe, lr, aioProbeAlways, aioProbeHlFallback }) {
  const params = { engine: 'google', q: query, location, google_domain, gl, hl, num, device: 'desktop', safe, no_cache: true, api_key: apiKey };
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
    const probeParams = { engine: 'google_ai_overview', q: query, location, google_domain, gl, hl: (hl.toLowerCase() === 'en' ? 'en' : aioProbeHlFallback), api_key: apiKey };
    try {
      const { data: aio } = await axios.get('https://serpapi.com/search.json', { params: probeParams, timeout: 45000 });
      if (aio && aio.ai_overview && Object.keys(aio.ai_overview).length) features.AIOverview = true;
      aioProbeUsed = true;
    } catch {}
  }
  const google_url = data?.search_metadata?.google_url || null;
  return { urls, features, raw: data, google_url, aioProbeUsed };
}

/** ====================== HTML verify ====================== **/
async function verifyOnHtml({ query, google_url, google_domain, gl, hl, extraWaitMs }) {
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

/** ====================== Headings extraction (same as v5) ====================== **/
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

/** ====================== Output (same as v5) ====================== **/
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
  const { createObjectCsvWriter } = require('csv-writer');
  const csvWriter = createObjectCsvWriter({ path, header });
  await csvWriter.writeRecords(rows);
  console.log(`💾 Wrote ${path}`);
}

/** ====================== Main ====================== **/
(async () => {
  function parseArgsRuntime() { return (typeof parseArgs === 'function') ? parseArgs() : {}; }
  const argv = parseArgsRuntime();

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
