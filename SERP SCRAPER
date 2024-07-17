from bs4 import BeautifulSoup, NavigableString
import requests
import pandas as pd
from google.colab import files

def scrape_seo_results(query, country_code):
    # Perform a Google search
    url = f"https://www.google.com/search?q={query}&gl={country_code}"
    headers = {'User-Agent': 'Mozilla/5.0'}
    response = requests.get(url, headers=headers)

    # Parse the HTML response
    soup = BeautifulSoup(response.text, 'html.parser')

    # Extract URLs of the top 10 search results
    urls = []
    for result in soup.find_all('div', class_='tF2Cxc'):
        link = result.find('a')['href']
        urls.append(link)

    return urls

def extract_h2_recursive(element):
    h2_texts = []

    if element.name == 'h2':
        h2_texts.append(element.text.strip())

    for child in element.children:
        if isinstance(child, NavigableString):
            continue
        h2_texts.extend(extract_h2_recursive(child))

    return h2_texts

def extract_h3_recursive(element):
    h3_texts = []

    if element.name == 'h3':
        h3_texts.append(element.text.strip())

    for child in element.children:
        if isinstance(child, NavigableString):
            continue
        h3_texts.extend(extract_h3_recursive(child))

    return h3_texts

def extract_data_from_url(url):
    # Send a request to the URL
    headers = {'User-Agent': 'Mozilla/5.0'}
    response = requests.get(url, headers=headers)

    if response.status_code != 200:
        print(f"Failed to fetch {url}. Status code: {response.status_code}")
        return {'url': url, 'meta': '', 'h1': '', 'h2': [], 'h3': []}

    # Parse the HTML response
    soup = BeautifulSoup(response.content.decode('utf-8', 'ignore'), 'html.parser')

    # Extract meta description
    meta_tag = soup.find('meta', attrs={'name': 'description'})
    meta = meta_tag['content'].strip() if meta_tag else ''

    # Extract H1
    h1 = soup.find('h1')
    h1_text = h1.text.strip() if h1 else ''

    # Extract all H2
    h2_texts = extract_h2_recursive(soup.body)

    # Extract all H3
    h3_texts = extract_h3_recursive(soup.body)

    return {'url': url, 'meta': meta, 'h1': h1_text, 'h2': h2_texts, 'h3': h3_texts}

# Define your search query and country code
query = "PLM Tools"
country_code = "JP"  # Change this to the desired country code

# Scrape SEO results
google_urls = scrape_seo_results(query, country_code)

# Define the list of URLs for manual extraction
manual_urls = [
    "https://jpn.nec.com/plm/about/abt-index.html",
    "https://www.scsk.jp/sp/itpnavi/article/2023/07/plm.html",
    "https://www.daikodenshi.jp/daiko-plus/production-control/what-is-plm/",
    "https://www.sap.com/japan/products/scm/plm-r-d-engineering/what-is-product-lifecycle-management.html",
    "https://www.toshibatec.co.jp/datasolution/column/20221201_01.html",
    "https://www.kaonavi.jp/dictionary/merchandising/",
    "https://smbiz.asahi.com/article/14997945",
    "https://bizhint.jp/keyword/225656",
    "https://www.nrc.co.jp/marketing/06-15.html",
    "https://www.mapmarketing.co.jp/mm-blog/store-development/kouri-md/"
]

# Combine manual URLs and Google search URLs
urls = manual_urls + google_urls[:10-len(manual_urls)]  # Take remaining URLs from Google search to make up to 10

# Prompt user for Excel filename
excel_filename = input("Enter the name for the Excel file (without extension): ") + ".xlsx"

# Create a list to store all data
data = []

# Extract data for each URL
for url in urls:
    extracted_data = extract_data_from_url(url)
    row = [extracted_data.get('url'), extracted_data.get('meta'), extracted_data.get('h1')]
    row.extend(extracted_data.get('h2', []))
    row.extend(extracted_data.get('h3', []))
    data.append(row)

# Add header for the Excel
header = ['URL', 'Meta Description', 'H1']
max_h2 = max(len(d[3:]) for d in data)  # Maximum number of H2 tags
max_h3 = max(len(d[3 + max_h2:]) for d in data)  # Maximum number of H3 tags
header.extend([f'H2_{i+1}' for i in range(max_h2)])
header.extend([f'H3_{i+1}' for i in range(max_h3)])

# Create a DataFrame and save to an Excel file
df = pd.DataFrame(data, columns=header)
df.to_excel(excel_filename, index=False)

# Download the Excel file
files.download(excel_filename)

print(f"Data saved successfully and downloaded as '{excel_filename}'.")
