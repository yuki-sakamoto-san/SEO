# ============================================
# STEP 1: Install dependencies
# ============================================
!pip -q install extruct w3lib[html] lxml tldextract httpx[http2] selectolax[parser] pandas tqdm aiohttp aiolimiter urllib3==2.2.2
# Optional, if you need JS-rendered schema (slower):
# !pip -q install playwright
# !playwright install chromium

# ============================================
# STEP 2: Config (prompts)
# ============================================
from urllib.parse import urlparse
import os, datetime

DOMAIN = input("Enter the full domain URL (e.g., https://www.example.com): ").strip()
try:
    MAX_PAGES = int(input("Max pages to crawl (e.g., 2000): ").strip())
except:
    MAX_PAGES = 2000

PRIORITY          = "both"      # "sitemap" | "crawl" | "both"
RESPECT_ROBOTS    = True
REQUESTS_PER_SEC  = 3
TIMEOUT_SECS      = 20
RENDER_JS         = False       # True only if schema is injected via JS
INCLUDE_QUERYSTR  = False
ALLOWED_PATHS     = []          # e.g., ["/ja_JP/"]
EXCLUDE_PATHS     = ["/wp-admin", "/cart", "/checkout"]
USER_AGENT        = "SchemaAuditBot/1.0 (+https://github.com/)"

# Local output folder & prefix
ts = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
hostname = urlparse(DOMAIN).netloc.replace(":", "_")
OUT_DIR = f"/content/schema_audit_{hostname}_{ts}"
os.makedirs(OUT_DIR, exist_ok=True)
OUT_PREFIX = os.path.join(OUT_DIR, "schema_audit")

print(f"\nCrawling: {DOMAIN}")
print(f"Max pages: {MAX_PAGES}")
print(f"Saving to: {OUT_DIR}")

# ============================================
# STEP 3: Utilities (crawling + schema extract)
# ============================================
import re, asyncio, urllib.parse, io, json
from urllib.parse import urljoin, urlparse, urlunparse
from collections import defaultdict
import tldextract, pandas as pd
from tqdm.auto import tqdm
import aiohttp
from aiolimiter import AsyncLimiter
from selectolax.parser import HTMLParser
import lxml.etree as ET
import extruct

def normalize_url(url, base=None, strip_query=True):
    if base:
        url = urljoin(base, url)
    p = urlparse(url)
    if strip_query:
        p = p._replace(query="", fragment="")
    return urlunparse((p.scheme, p.netloc, p.path or "/", p.params, p.query, ""))

def is_same_site(url, root):
    u, r = urlparse(url), urlparse(root)
    tu, tr = tldextract.extract(u.netloc), tldextract.extract(r.netloc)
    return (tu.domain, tu.suffix) == (tr.domain, tr.suffix)

def allowed_path(path, include_list, exclude_list):
    if include_list and not any(path.startswith(p) for p in include_list):
        return False
    if any(path.startswith(p) for p in exclude_list):
        return False
    return True

async def fetch_text(session, url, timeout, render=False):
    async with session.get(url, timeout=timeout) as r:
        r.raise_for_status()
        return await r.text()

def parse_sitemaps(xml_str):
    urls = set()
    try:
        root = ET.fromstring(xml_str.encode("utf-8"))
    except Exception:
        return urls
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    for loc in root.findall(".//sm:url/sm:loc", ns):
        urls.add(loc.text.strip())
    return urls

def extract_structured_data(html, url):
    try:
        data = extruct.extract(
            html,
            base_url=url,
            syntaxes=["json-ld","microdata","rdfa"],
            uniform=True
        )
        return data, None
    except Exception as e:
        return None, str(e)

async def extract_links(html, base_url):
    links = set()
    try:
        doc = HTMLParser(html)
        for a in doc.css("a[href]"):
            href = a.attributes.get("href")
            if not href: continue
            url = normalize_url(href, base=base_url, strip_query=not INCLUDE_QUERYSTR)
            links.add(url)
    except: 
        pass
    return links

async def crawl(root, mode="sitemap", max_pages=1000):
    results, errors, seen = [], [], set()
    queue = []

    # Seed: use root; additional sitemap seeding is handled by attempting to fetch /sitemap.xml during crawl
    queue.append(normalize_url(root, strip_query=not INCLUDE_QUERYSTR))

    limiter = AsyncLimiter(REQUESTS_PER_SEC, time_period=1)
    timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECS)
    headers = {"User-Agent": USER_AGENT}

    async with aiohttp.ClientSession(headers=headers, timeout=timeout) as session:
        pbar = tqdm(total=max_pages, desc="Crawling")
        while queue and len(seen) < max_pages:
            url = queue.pop(0)
            if url in seen or not is_same_site(url, root): 
                continue
            if not allowed_path(urlparse(url).path, ALLOWED_PATHS, EXCLUDE_PATHS):
                continue

            seen.add(url)
            try:
                async with limiter:
                    html = await fetch_text(session, url, TIMEOUT_SECS)
                data, err = extract_structured_data(html, url)
                sd_items, schema_types = [], []
                if data:
                    for syntax in ("json-ld","microdata","rdfa"):
                        for item in data.get(syntax, []):
                            sd_items.append({"syntax": syntax, "item": item})
                            t = item.get("@type") or item.get("type")
                            if isinstance(t, list): schema_types.extend(t)
                            elif isinstance(t, str): schema_types.append(t)
                results.append({
                    "url": url,
                    "has_schema": bool(sd_items),
                    "schema_types": sorted(set(map(str, schema_types))),
                    "num_items": len(sd_items),
                    "raw": data or {}
                })

                # Follow internal links
                if mode in ("crawl","both"):
                    new_links = await extract_links(html, url)
                    for link in new_links:
                        if link not in seen and is_same_site(link, root):
                            if allowed_path(urlparse(link).path, ALLOWED_PATHS, EXCLUDE_PATHS):
                                queue.append(link)

                pbar.update(1)
            except Exception as e:
                errors.append({"url": url, "error": str(e)})
        pbar.close()

    return results, errors

# ============================================
# STEP 4: Run the crawl & save CSVs locally
# ============================================
results, errors = await crawl(DOMAIN, mode=PRIORITY, max_pages=MAX_PAGES)

import pandas as pd

df = pd.DataFrame(results)

if df.empty:
    print("No pages crawled. Check domain, network, or restrictions.")
    # Still emit empty files for consistency
    pd.DataFrame(columns=["url","schema_types","num_items"]).to_csv(f"{OUT_PREFIX}_pages_with_schema.csv", index=False)
    pd.DataFrame(columns=["url"]).to_csv(f"{OUT_PREFIX}_pages_without_schema.csv", index=False)
    pd.DataFrame(columns=["pages_with_type"]).to_csv(f"{OUT_PREFIX}_per_type.csv")
    pd.DataFrame(columns=["url","raw"]).to_csv(f"{OUT_PREFIX}_raw.csv", index=False)
    pd.DataFrame(errors).to_csv(f"{OUT_PREFIX}_errors.csv", index=False)
else:
    total = len(df)
    with_sd = int(df["has_schema"].sum())
    coverage = (with_sd / total * 100) if total else 0.0

    print(f"Total pages crawled: {total}")
    print(f"Pages with schema:   {with_sd}")
    print(f"Coverage:            {coverage:.2f}%")

    # Save main tables
    df.to_csv(f"{OUT_PREFIX}_raw.csv", index=False)
    df[df["has_schema"]].to_csv(f"{OUT_PREFIX}_pages_with_schema.csv", index=False)
    df[~df["has_schema"]].to_csv(f"{OUT_PREFIX}_pages_without_schema.csv", index=False)

    # Per-type (pages using each @type at least once)
    df_types = df.explode("schema_types")
    if "schema_types" in df_types.columns and df_types["schema_types"].notna().any():
        per_type = (
            df_types[df_types["schema_types"].notna()]
            .groupby("schema_types")["url"]
            .nunique()
            .sort_values(ascending=False)
            .rename("pages_with_type")
            .to_frame()
        )
    else:
        per_type = pd.DataFrame(columns=["pages_with_type"])

    per_type.to_csv(f"{OUT_PREFIX}_per_type.csv")

    # Errors, if any
    pd.DataFrame(errors).to_csv(f"{OUT_PREFIX}_errors.csv", index=False)

    print("\nSaved files:")
    for fn in sorted(os.listdir(OUT_DIR)):
        print(" -", fn)

# ============================================
# STEP 5: (Optional) Quick peek at top schema types
# ============================================
try:
    import pandas as pd, os
    per_type_path = f"{OUT_PREFIX}_per_type.csv"
    if os.path.exists(per_type_path):
        per_type_df = pd.read_csv(per_type_path)
        display(per_type_df.head(20))
    else:
        print("No per-type file found (likely no schema detected).")
except Exception as e:
    print("Preview error:", e)

# ============================================
# STEP 6: ZIP the results and download
# ============================================
import shutil, os
from google.colab import files

zip_path = f"{OUT_DIR}.zip"
if os.path.exists(zip_path):
    os.remove(zip_path)

shutil.make_archive(OUT_DIR, 'zip', OUT_DIR)
print("Created ZIP:", zip_path)

# Trigger browser download
files.download(zip_path)

