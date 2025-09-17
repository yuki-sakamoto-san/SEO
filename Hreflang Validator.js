pip install requests-html pandas

import asyncio
import nest_asyncio
from requests_html import AsyncHTMLSession
import pandas as pd
import xml.etree.ElementTree as ET

nest_asyncio.apply()

async def get_internal_links(url, domain):
    session = AsyncHTMLSession()
    try:
        response = await session.get(url)
        await response.html.arender()
    except Exception as e:
        print(f"Request failed: {e}")
        return set()
    
    links = set()
    for a_tag in response.html.find('a'):
        href = a_tag.attrs.get('href')
        if href and (domain in href or href.startswith('/')):
            if href.startswith('/'):
                href = f"{domain}{href}"
            links.add(href)
    return links

def get_sitemap_links(sitemap_url):
    try:
        response = requests.get(sitemap_url)
        response.raise_for_status()
        root = ET.fromstring(response.content)
    except Exception as e:
        print(f"Failed to fetch or parse sitemap: {e}")
        return []
    
    links = []
    for elem in root.iter():
        if 'loc' in elem.tag:
            links.append(elem.text)
    return links

async def get_hreflang_tags(url):
    session = AsyncHTMLSession()
    try:
        response = await session.get(url)
        await response.html.arender()
    except Exception as e:
        print(f"Request failed: {e}")
        return []
    
    hreflang_tags = []
    for link_tag in response.html.find('link[rel="alternate"]'):
        hreflang = link_tag.attrs.get('hreflang')
        href = link_tag.attrs.get('href')
        if hreflang and href:
            hreflang_tags.append((hreflang, href))
    return hreflang_tags

def validate_hreflang_tags(tags, domain):
    valid_tags = []
    invalid_tags = []
    for hreflang, href in tags:
        if domain in href:
            valid_tags.append((hreflang, href))
        else:
            invalid_tags.append((hreflang, href))
    return valid_tags, invalid_tags

def export_to_excel(valid_tags, invalid_tags, output_file):
    df_valid = pd.DataFrame(valid_tags, columns=['Hreflang', 'URL'])
    df_invalid = pd.DataFrame(invalid_tags, columns=['Hreflang', 'URL'])
    with pd.ExcelWriter(output_file) as writer:
        df_valid.to_excel(writer, sheet_name='Valid Hreflang Tags', index=False)
        df_invalid.to_excel(writer, sheet_name='Invalid Hreflang Tags', index=False)
    print(f"Data exported to {output_file}")

async def main():
    start_url = input("Enter the start URL: ")
    domain = input("Enter the domain (e.g., 'https://www.example.com'): ")

    print(f"Fetching Hreflang tags from {start_url}...")
    hreflang_tags = await get_hreflang_tags(start_url)

    if not hreflang_tags:
        print("No Hreflang tags found on the start URL.")
    else:
        print(f"Validating Hreflang tags found on the start URL...")
        valid_tags, invalid_tags = validate_hreflang_tags(hreflang_tags, domain)
        print(f"Found {len(valid_tags)} valid Hreflang tags and {len(invalid_tags)} invalid Hreflang tags.")
        output_file = "hreflang_validation.xlsx"
        export_to_excel(valid_tags, invalid_tags, output_file)
    
    sitemap_url = input("Enter the sitemap URL (optional, press enter to skip): ")
    if sitemap_url:
        sitemap_links = get_sitemap_links(sitemap_url)
        all_hreflang_tags = []
        for link in sitemap_links:
            print(f"Fetching Hreflang tags from {link}...")
            tags = await get_hreflang_tags(link)
            all_hreflang_tags.extend(tags)
        
        if all_hreflang_tags:
            print(f"Validating Hreflang tags found in the sitemap...")
            valid_tags, invalid_tags = validate_hreflang_tags(all_hreflang_tags, domain)
            print(f"Found {len(valid_tags)} valid Hreflang tags and {len(invalid_tags)} invalid Hreflang tags in the sitemap.")
            output_file = "hreflang_sitemap_validation.xlsx"
            export_to_excel(valid_tags, invalid_tags, output_file)
        else:
            print("No Hreflang tags found in the sitemap.")

if __name__ == "__main__":
    asyncio.run(main())
