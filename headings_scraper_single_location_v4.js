// File: headings_scraper_single_location_v4.js
// Single-location SERP + FULL headings with iframe traversal + robust AIO detection.
//
// Key fixes vs v3:
//  - Noindex: do NOT skip pages unless --respectNoindex=true
//  - Iframes: traverse same-origin frames and merge heading results
//  - Headers: set Accept-Language for all requests
//  - Re-render retry: if very few headings found, do an extra wait + scroll pass
//  - Strong AIO: same as v3 with proactive google_ai_overview probe
//  - Rich debug: writes per-frame counts and retry info
//
// Install: npm i playwright googleapis axios csv-writer
//
// Example:
// node headings_scraper_single_location_v4.js \
//   --query="Chargeback" \
//   --location="Australia" \
//   --google_domain="google.com.au" \
//   --gl="au" \
//   --hl="en" \
//   --apiKey="YOUR_SERPAPI_KEY" \
//   --sheetId="YOUR_SHEET_ID" --sheetName="Headings" --serviceAccountKey="./service_account.json" \
//   --verifySerpWithPlaywright=true \
//   --aioProbeAlways=true \
//   --aioProbeHlFallback=en \
//   --includeHidden=true \
//   --headingLike=true \
//   --respectNoindex=false \
//   --extraWaitMs=2500 \
//   --scrollSteps=18 --scrollStepPx=1000
//
const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');
const { google } = require('googleapis');
const { createObjectCsvWriter } = require('csv-writer');

/** ============== CLI ============== **/
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out.query) throw new Error('Missing --query');
  if (!out.location) throw new Error('Missing --location');
  out.google_domain = out.google_domain || 'google.com.au';
  out.gl = out.gl || 'au';
  out.hl = out.hl || 'en';
  if (!out.apiKey) throw new Error('Missing --apiKey');
  out.sheetId = out.sheetId || process.env.SHEET_ID;
  out.sheetName = out.sheetName || process.env.SHEET_NAME || 'Headings';
  out.serviceAccountKey = out.serviceAccountKey || process.env.SERVICE_ACCOUNT_KEY;
  out.maxUnique = parseInt(out.maxUnique || '10', 10);
  out.verifySerpWithPlaywright = String(out.verifySerpWithPlaywright || 'false').toLowerCase() === 'true';
  out.aioProbeAlways = String(out.aioProbeAlways || 'false').toLowerCase() === 'true';
  out.aioProbeHlFallback = out.aioProbeHlFallback || 'en';
  out.includeHidden = String(out.includeHidden || 'true').toLowerCase() === 'true';
  out.headingLike = String(out.headingLike || 'true').toLowerCase() === 'true';
  out.respectNoindex = String(out.respectNoindex || 'false').toLowerCase() === 'true';
  out.extraWaitMs = parseInt(out.extraWaitMs || '1500', 10);
  out.scrollSteps = parseInt(out.scrollSteps || '14', 10);
  out.scrollStepPx = parseInt(out.scrollStepPx || '900', 10);
  out.retryIfFewHeadings = parseInt(out.retryIfFewHeadings || '2', 10); // if total H1–H6 < 2, retry once
  return out;
}

/** ============== Helpers ============== **/
function hasAioInSerpapiData(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.ai_overview && Object.keys(d.ai_overview).length) return true;
  if (d.ai_overview_results && Object.keys(d.ai_overview_results).length) return true;
  if (d.search_information && (d.search_information.ai_overview || d.search_information.ai_overview_is_available)) return true;
  if (d.knowledge_graph && d.knowledge_graph.ai_overview) return true;
  return false;
}
function buildUule(loc) {
  const b64 = Buffer.from(loc, 'utf8').toString('base64');
  return `w+CAIQICI${b64}`;
}
function mergeHeadings(a, b) {
  const out = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
  for (const k of Object.keys(out)) {
    out[k] = [...(a[k]||[]), ...(b[k]||[])];
  }
  return out;
}

/** ============== SerpAPI single-location ============== **/
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
  const urls = (data.organic_results || []).map(r => r.link).filter(Boolean);
  const features = {
    FeaturedSnippet: !!(data.answer_box || data.featured_snippet),
    KnowledgePanel: !!data.knowledge_graph,
    PeopleAlsoAsk: !!(data.related_questions || data.people_also_ask),
    ImagePack: !!data.inline_images,
    Video: !!(data.inline_videos || data.video_results),
    AIOverview: hasAioInSerpapiData(data)
  };
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

/** ============== HTML verify (optional) ============== **/
async function verifySerpOnGoogleHtml({ query, location, google_domain, gl, hl, extraWaitMs }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: hl,
    extraHTTPHeaders: { 'Accept-Language': hl },
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
        if (steps < 12) setTimeout(step, 180);
        else res();
      };
      step();
    });
  });
  if (extraWaitMs) await page.waitForTimeout(parseInt(extraWaitMs,10));

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

/** ============== Headings extraction with iframe traversal ============== **/
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

async function renderAndExtract(url, hl, {
  extraWaitMs, scrollSteps, scrollStepPx, includeHidden, headingLike, respectNoindex, retryIfFewHeadings
}) {
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

  // Extract from main frame + same-origin iframes
  const frames = page.frames();
  let merged = { h1:[], h2:[], h3:[], h4:[], h5:[], h6:[] };
  const frameDebug = [];
  for (const f of frames) {
    try {
      const sameOrigin = await f.evaluate(() => true); // will throw if cross-origin
      if (!sameOrigin) continue;
      const h = await extractHeadingsInFrame(f, { includeHidden, headingLike });
      frameDebug.push({ url: f.url(), counts: { h1: h.h1.length, h2: h.h2.length, h3: h.h3.length, h4: h.h4.length, h5: h.h5.length, h6: h.h6.length } });
      merged = mergeHeadings(merged, h);
    } catch {
      // cross-origin frame, skip
    }
  }

  // If too few headings, one more gentle pass
  const total = merged.h1.length + merged.h2.length + merged.h3.length + merged.h4.length + merged.h5.length + merged.h6.length;
  if (total < retryIfFewHeadings) {
    await page.evaluate(async ({ scrollSteps, scrollStepPx }) => {
      await new Promise(res => {
        let steps = 0;
        const step = () => {
          window.scrollBy(0, scrollStepPx);
          steps++;
          if (steps < scrollSteps) setTimeout(step, 140);
          else res();
        };
        step();
      });
    }, { scrollSteps: Math.max(10, Math.floor(scrollSteps * 1.2)), scrollStepPx });
    await page.waitForTimeout(extraWaitMs + 500);
    // Re-extract main frame only to avoid duplicates from re-counting iframes
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

/** ============== Output builders ============== **/
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

/** ============== Sheets / CSV ============== **/
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
async function writeCsv(path, header, rows) {
  const csvWriter = createObjectCsvWriter({ path, header });
  await csvWriter.writeRecords(rows);
  console.log(`💾 Wrote ${path}`);
}

/** ============== Main ============== **/
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

  // 3) Optional verify on HTML
  let verify = null;
  if (argv.verifySerpWithPlaywright) {
    verify = await verifySerpOnGoogleHtml({
      query: argv.query,
      location: argv.location,
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
    features,
    verify,
    raw_sample: raw?.search_metadata ? {
      google_url: raw.search_metadata.google_url,
      created_at: raw.search_metadata.created_at
    } : null,
    heading_max_cols: maxCols
  };

  // Write debug
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
