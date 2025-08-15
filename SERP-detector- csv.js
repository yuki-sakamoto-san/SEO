// File: playwright_serp_headings.js
// Deps: npm i playwright csv-writer
// Run examples:
//   node playwright_serp_headings.js --query="ERP" --country="Australia" --language="en" --maxCities=6
//   node playwright_serp_headings.js --query="payments platform" --country="New Zealand" --language="en-NZ"
//
// Outputs:
//   - serp_headings.csv (full headings, no caps)
//   - serp_summary.json (SERP features + de-duped top results with per-city frequency)
//
// Notes:
//   - Country-wide targeting is approximated by sampling multiple major cities in the target country.
//     We fetch SERPs per city using domain + gl + hl + uule and aggregate organic URLs across cities.
//     Then we rank URLs by frequency across cities and keep the top N unique results (default 10).
//   - For rendering each page, we do networkidle waits, human scroll, extra delay, open-shadow traversal,
//     heading-like detection via computed styles, and an optional QC re-render if counts are too low.

const fs = require('fs');
const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');

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
  return out;
}

/** ====================== Country Config ====================== **/
const COUNTRY_CONFIG = {
  'Australia': {
    gl: 'au',
    domain: 'https://www.google.com.au/search',
    tz: 'Australia/Sydney',
    cities: [
      { name: 'Sydney, NSW', lat: -33.8688, lon: 151.2093 },
      { name: 'Melbourne, VIC', lat: -37.8136, lon: 144.9631 },
      { name: 'Brisbane, QLD', lat: -27.4698, lon: 153.0251 },
      { name: 'Perth, WA', lat: -31.9523, lon: 115.8613 },
      { name: 'Adelaide, SA', lat: -34.9285, lon: 138.6007 },
      { name: 'Canberra, ACT', lat: -35.2809, lon: 149.1300 },
      { name: 'Hobart, TAS', lat: -42.8821, lon: 147.3272 },
      { name: 'Gold Coast, QLD', lat: -28.0167, lon: 153.4000 },
    ]
  },
  'New Zealand': {
    gl: 'nz',
    domain: 'https://www.google.co.nz/search',
    tz: 'Pacific/Auckland',
    cities: [
      { name: 'Auckland', lat: -36.8485, lon: 174.7633 },
      { name: 'Wellington', lat: -41.2866, lon: 174.7756 },
      { name: 'Christchurch', lat: -43.5320, lon: 172.6362 },
      { name: 'Hamilton', lat: -37.7870, lon: 175.2793 },
      { name: 'Tauranga', lat: -37.6878, lon: 176.1651 },
      { name: 'Dunedin', lat: -45.8788, lon: 170.5028 },
    ]
  },
  'Singapore': {
    gl: 'sg',
    domain: 'https://www.google.com.sg/search',
    tz: 'Asia/Singapore',
    cities: [
      { name: 'Singapore', lat: 1.3521, lon: 103.8198 }
    ]
  },
  'Malaysia': {
    gl: 'my',
    domain: 'https://www.google.com.my/search',
    tz: 'Asia/Kuala_Lumpur',
    cities: [
      { name: 'Kuala Lumpur', lat: 3.1390, lon: 101.6869 },
      { name: 'Penang', lat: 5.4164, lon: 100.3327 },
      { name: 'Johor Bahru', lat: 1.4927, lon: 103.7414 },
      { name: 'Kota Kinabalu', lat: 5.9804, lon: 116.0735 },
      { name: 'Kuching', lat: 1.5535, lon: 110.3593 },
    ]
  },
  'India': {
    gl: 'in',
    domain: 'https://www.google.co.in/search',
    tz: 'Asia/Kolkata',
    cities: [
      { name: 'Mumbai', lat: 19.0760, lon: 72.8777 },
      { name: 'Delhi', lat: 28.7041, lon: 77.1025 },
      { name: 'Bengaluru', lat: 12.9716, lon: 77.5946 },
      { name: 'Hyderabad', lat: 17.3850, lon: 78.4867 },
      { name: 'Chennai', lat: 13.0827, lon: 80.2707 },
      { name: 'Kolkata', lat: 22.5726, lon: 88.3639 },
    ]
  }
};

/** ====================== Helpers ====================== **/
function buildUule(city) {
  // Minimal UULE variant
  const b64 = Buffer.from(city, 'utf8').toString('base64');
  return `w+CAIQICI${b64}`;
}

function serpUrl({ domain, query, language, gl, city }) {
  const params = new URLSearchParams({
    q: query,
    hl: language,
    gl,
    num: '10',
    pws: '0',
    uule: buildUule(city),
  });
  return `${domain}?${params.toString()}`;
}

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

/** Robust AI Overview detector (multi-signal) */
async function detectAIOverview(page) {
  let genAiNetworkSeen = false;
  const netListener = (req) => {
    const u = req.url();
    if ( /genai|searchgenai|unified_qa|\\/_\\/SearchGenAI|_batchexecute/i.test(u) && /google\\./i.test(u) ) {
      genAiNetworkSeen = true;
    }
  };
  page.on('request', netListener);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  const AIO_LOCALIZED_LABELS = [/ai overview/i, /overview from ai/i, /generated by ai/i, /ai オーバービュー/i];
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
      const text = (await el.evaluate(n => (n.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 2000))).toLowerCase();
      if (!text) continue;
      if (AIO_LOCALIZED_LABELS.some(rx => rx.test(text))) {
        if (await isVisibleEl(el)) {
          return { present: true, collapsed: /show more|generate|view more/i.test(text), where: 'text-match' };
        }
      }
    }
    const aria = page.locator('div[aria-label*="AI Overview" i], div[role="region"]');
    const count = await aria.count();
    for (let i=0; i<count; i++) {
      const el = aria.nth(i);
      if (await isVisibleEl(el)) {
        const t = (await el.innerText()).trim();
        if (AIO_LOCALIZED_LABELS.some(rx => rx.test(t))) {
          return { present: true, collapsed: /show more|generate|view more/i.test(t), where: 'aria' };
        }
      }
    }
    const sources = page.locator('a[aria-label*="About this result" i], div:has-text("From the web")');
    if (await sources.count()) return { present: true, collapsed: false, where: 'sources' };
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
  return { aiOverview: !!result.present, collapsed: !!result.collapsed, viaNetwork: genAiNetworkSeen, where: result.where || 'none' };
}

/** SERP collection for a single city */
async function collectSerpForCity({ browser, query, language, config, city }) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: language,
    geolocation: { latitude: city.lat, longitude: city.lon },
    timezoneId: config.tz,
    permissions: ['geolocation'],
  });
  const page = await context.newPage();
  const url = serpUrl({ domain: config.domain, query, language, gl: config.gl, city: city.name });

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // consent click if present
  try {
    const consent = page.locator('button:has-text("I agree"), button:has-text("Accept all"), button:has-text("Accept")').first();
    if (await consent.isVisible({ timeout: 2000 })) await consent.click();
  } catch {}

  // Organic URLs
  const urls = await page.evaluate(() => {
    const out = [];
    const blocks = document.querySelectorAll('div.g, div[data-sokoban-container]');
    for (const b of blocks) {
      const ad = b.querySelector('[data-text-ad], [aria-label*="Ads"], [aria-label*="Sponsored"]');
      if (ad) continue;
      const a = b.querySelector('a[href^="http"]');
      const h3 = b.querySelector('h3');
      if (a && h3 && a.href && !a.href.includes('/search?') && !a.href.includes('google.')) {
        out.push(a.href);
      }
      if (out.length >= 10) break;
    }
    return out;
  });

  const aio = await detectAIOverview(page);

  // Other features (quick heuristics)
  const features = await page.evaluate(() => ({
    FeaturedSnippet: !!document.querySelector('[data-attrid="wa:/description"], [data-attrid="kc:/webanswers:wa"]'),
    KnowledgePanel: !!document.querySelector('#kp-wp-tab-overview, [data-attrid="title"]'),
    PeopleAlsoAsk: !!document.querySelector('div[aria-label*="People also ask"], div[jsname="Cpkphb"]'),
    Video: !!document.querySelector('g-scrolling-carousel a[href*="youtube.com"], a[href*="watch?v="]'),
    ImagePack: !!document.querySelector('g-scrolling-carousel img, div[data-hveid][data-ved] img')
  }));
  features.AIOverview = aio.aiOverview;
  features.AIOverviewCollapsed = aio.collapsed;
  features.AIOverviewNetworkSignal = aio.viaNetwork;

  await context.close();
  return { city: city.name, urls, features };
}

/** Render a URL and extract headings/meta */
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

  // robots noindex check
  const robots = await page.locator('meta[content*="noindex"]').first();
  if (await robots.count()) { await context.close(); return null; }

  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.waitForTimeout(1800);
  await humanScroll(page);

  let meta = await extractMeta(page);
  let heads = await extractHeadings(page);

  // QC retry
  if (heads.length < 6) {
    await page.waitForTimeout(5000);
    await humanScroll(page);
    const meta2 = await extractMeta(page);
    const heads2 = await extractHeadings(page);
    if (heads2.length > heads.length) { meta = meta2; heads = heads2; }
  }

  // group by level
  const grouped = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const h of heads) {
    const lv = Math.min(Math.max(h.level,1),6);
    grouped[lv].push(h.text);
  }
  await context.close();
  return { url, meta, grouped };
}

/** ====================== Main Orchestrator ====================== **/
(async () => {
  const { query, country, language, maxCities, maxUnique } = parseArgs();
  const config = COUNTRY_CONFIG[country];
  if (!config) {
    console.error(`Unsupported country "${country}". Supported: ${Object.keys(COUNTRY_CONFIG).join(', ')}`);
    process.exit(1);
  }
  const cities = config.cities.slice(0, Math.max(1, maxCities));

  const browser = await chromium.launch({ headless: true });

  // 1) Collect SERP per city
  const perCity = [];
  for (const city of cities) {
    try {
      const r = await collectSerpForCity({ browser, query, language, config, city });
      perCity.push(r);
    } catch (e) {
      // continue
    }
  }

  // 2) Aggregate organic URLs by frequency across cities
  const urlFreq = new Map();
  for (const r of perCity) {
    for (const u of (r?.urls || [])) {
      const norm = u.replace(/#.*$/, '');
      urlFreq.set(norm, (urlFreq.get(norm) || 0) + 1);
    }
  }
  // rank by frequency desc, then alpha as tie-breaker
  const ranked = [...urlFreq.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topUnique = ranked.slice(0, maxUnique).map(([u, f]) => ({ url: u, freq: f }));

  // 3) Render each unique URL and extract headings/meta
  const pageData = [];
  for (const item of topUnique) {
    const row = await renderAndExtract({ browser, language, tz: config.tz, url: item.url });
    if (row) pageData.push(row);
  }

  await browser.close();

  // 4) Build CSV header dynamically from max per level
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

  const csvWriter = createObjectCsvWriter({ path: 'serp_headings.csv', header });
  await csvWriter.writeRecords(rows);

  // 5) Summarize SERP features across cities (union + counts)
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
    sampledCities: cities.map(c => c.name),
    perCity: perCity.map(x => ({ city: x.city, urls: x.urls, features: x.features })),
    aggregatedFeatures: featureAgg,
    topUniqueResults: topUnique
  };
  fs.writeFileSync('serp_summary.json', JSON.stringify(summary, null, 2));

  console.log('Done. Files written: serp_headings.csv, serp_summary.json');
})().catch(e => { console.error(e); process.exit(1); });
