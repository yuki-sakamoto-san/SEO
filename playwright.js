// package.json deps: "playwright": "^1.45.0", "csv-writer": "^1.6.0"
// run: node scrape.js

const fs = require('fs');
const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');

/** ===== Utilities ===== **/

function buildUule(city) {
  // Minimal UULE builder: “w+CAIQICI<base64(city)>” often works.
  // For production, use a robust encoder. This is enough for accurate AU targeting in most cases.
  const b64 = Buffer.from(city, 'utf8').toString('base64');
  return `w+CAIQICI${b64}`;
}

function googleSerpUrl({ query, countryCode, language, city }) {
  const domain = countryCode.toLowerCase() === 'au' ? 'https://www.google.com.au/search' : 'https://www.google.com/search';
  const params = new URLSearchParams({
    q: query,
    hl: language,      // e.g., en or en-AU
    gl: countryCode,   // e.g., au
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
          setTimeout(res, 500);
        }
      }, 100);
    });
  });
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

async function getComputedNumber(styles, prop) {
  const v = parseFloat(styles.getPropertyValue(prop));
  return isNaN(v) ? 0 : v;
}

/** Extract headings including heading-like and open shadow DOM */
async function extractHeadings(page) {
  return await page.evaluate(() => {
    // Helper: walk shadow roots (open only)
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

    function isHeadingLike(el, styles) {
      const fontWeight = styles.getPropertyValue('font-weight');
      const weightNum = parseInt(fontWeight, 10);
      const sizePx = parseFloat(styles.getPropertyValue('font-size')) || 0;

      const heavy = (Number.isFinite(weightNum) ? weightNum >= 600 : ['bold','bolder'].includes(fontWeight));
      const big = sizePx >= 18;

      const idClass = (el.id + ' ' + el.className).toLowerCase();
      const semantic = el.getAttribute('role') === 'heading' ||
        idClass.includes('title') ||
        idClass.includes('heading') ||
        idClass.includes('headline') ||
        idClass.includes('section-title');

      // exclude obvious nav/footers
      const role = (el.getAttribute('role') || '').toLowerCase();
      const inNav = role === 'navigation';
      return !inNav && (semantic || (heavy && big));
    }

    function visible(el, styles) {
      const rect = el.getBoundingClientRect();
      if (rect.height === 0 || rect.width === 0) return false;
      const disp = styles.getPropertyValue('display');
      const vis = styles.getPropertyValue('visibility');
      return disp !== 'none' && vis !== 'hidden';
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
        // infer level roughly from font-size buckets
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

    // sort by DOM visual Y
    headings.sort((a,b) => a.y - b.y);
    return headings;
  });
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

/** ===== Main ===== **/

async function scrape({ query, targetCountry='AU', targetLanguage='en', targetCity='Sydney, NSW' }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: targetLanguage,
    geolocation: { latitude: -33.8688, longitude: 151.2093 }, // Sydney
    timezoneId: 'Australia/Sydney',
    permissions: ['geolocation'],
  });
  const page = await context.newPage();

  // --- SERP ---
  const serpUrl = googleSerpUrl({
    query,
    countryCode: targetCountry.toLowerCase(),
    language: targetLanguage,
    city: targetCity
  });

  await page.goto(serpUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // accept consent if present
  try {
    const consent = page.locator('button:has-text("I agree"), button:has-text("Accept all"), button:has-text("Accept")').first();
    if (await consent.isVisible({ timeout: 2000 })) await consent.click();
  } catch {}

  // Collect top 10 organic (skip ads/features)
  const results = await page.evaluate(() => {
    // Organic results typically in 'a' tags inside h3 parents; be conservative
    const urls = [];
    const blocks = document.querySelectorAll('div.g, div[data-sokoban-container]'); // broad
    for (const b of blocks) {
      const ad = b.querySelector('[data-text-ad], [aria-label*="Ads"], [aria-label*="Sponsored"]');
      if (ad) continue;
      const a = b.querySelector('a[href^="http"]');
      const h3 = b.querySelector('h3');
      if (a && h3 && a.href && !a.href.includes('/search?') && !a.href.includes('google.')) {
        urls.push(a.href);
      }
      if (urls.length >= 10) break;
    }
    return urls;
  });

  // Detect SERP features (quick heuristic)
  const serpFeatures = await page.evaluate(() => {
    const hasFS = !!document.querySelector('[data-attrid="wa:/description"], [data-attrid="kc:/webanswers:wa"]');
    const hasKP = !!document.querySelector('#kp-wp-tab-overview, [data-attrid="title"]');
    const hasPAA = !!document.querySelector('div[aria-label*="People also ask"], div[jsname="Cpkphb"]');
    const hasVideo = !!document.querySelector('g-scrolling-carousel a[href*="youtube.com"], a[href*="watch?v="]');
    const hasImagePack = !!document.querySelector('g-scrolling-carousel img, div[data-hveid][data-ved] img');
    const hasAIO = !!document.querySelector('div:has(> div[aria-label*="AI Overview"]), div[aria-label*="AI Overview"]');
    return { FeaturedSnippet: hasFS, KnowledgePanel: hasKP, PeopleAlsoAsk: hasPAA, Video: hasVideo, ImagePack: hasImagePack, AIOverview: hasAIO };
  });

  // Intent heuristic
  const intent = (function(q){
    const s = q.toLowerCase();
    if (/(buy|price|pricing|software|platform|tool|quote|demo|contact|vs|compare)/.test(s)) return 'Transactional/BOFU';
    if (/(best|top|how|what|guide|examples|ideas|learn|tutorial)/.test(s)) return 'Informational/TOFU';
    return 'MOFU';
  })(query);

  const pageData = [];
  for (const url of results) {
    const p = await context.newPage();
    try {
      await p.route('**/*', route => {
        // Send Referer to mimic human nav from Google
        const headers = { ...route.request().headers(), Referer: 'https://www.google.com/' };
        route.continue({ headers });
      });
      const resp = await p.goto(url, { waitUntil: 'load', timeout: 45000 });
      const status = resp ? resp.status() : 0;
      if (!status || status >= 400) { await p.close(); continue; }

      // robots noindex check
      const robots = await p.locator('meta[content*="noindex"]').first();
      if (await robots.count()) { await p.close(); continue; }

      await p.waitForLoadState('networkidle', { timeout: 20000 });
      await p.waitForTimeout(2000);
      await humanScroll(p);

      let meta = await extractMeta(p);
      let heads = await extractHeadings(p);

      // QC: if suspiciously low, re-render with more wait
      if (heads.length < 6) {
        await p.waitForTimeout(5000);
        await humanScroll(p);
        const meta2 = await extractMeta(p);
        const heads2 = await extractHeadings(p);
        if (heads2.length > heads.length) {
          meta = meta2;
          heads = heads2;
        }
      }

      // group by level
      const grouped = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
      for (const h of heads) {
        const lv = Math.min(Math.max(h.level,1),6);
        grouped[lv].push(h.text);
      }

      pageData.push({ url, meta, grouped });
    } catch (e) {
      // skip on error
    } finally {
      await p.close();
    }
  }

  // Determine max columns per level
  const maxCols = {1:0,2:0,3:0,4:0,5:0,6:0};
  for (const row of pageData) {
    for (let lv=1; lv<=6; lv++) {
      maxCols[lv] = Math.max(maxCols[lv], row.grouped[lv].length);
    }
  }

  // Build CSV header
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

  // Write CSV
  const csvWriter = createObjectCsvWriter({
    path: 'serp_headings.csv',
    header
  });
  await csvWriter.writeRecords(rows);

  await browser.close();

  // Return SERP summary for your agent to include alongside the CSV/Doc
  return {
    query,
    intent,
    serpFeatures,
    results
  };
}

// Example run (Australia, English, Sydney)
scrape({ query: 'ERP', targetCountry: 'AU', targetLanguage: 'en', targetCity: 'Sydney, NSW' })
  .then(summary => {
    fs.writeFileSync('serp_summary.json', JSON.stringify(summary, null, 2));
    console.log('Done. Files: serp_headings.csv, serp_summary.json');
  })
  .catch(e => { console.error(e); process.exit(1); });
