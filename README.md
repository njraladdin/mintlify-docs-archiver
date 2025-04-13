# Lovable Docs Archiver

A Node.js application that uses Puppeteer to download the Lovable documentation website for offline viewing.

## Features

- Scrapes the [Lovable documentation](https://docs.lovable.dev) website
- Downloads HTML, CSS, JavaScript, images, and other resources
- Maintains the same URL structure for local viewing
- Limits scraping to approved domains only
- Processes up to 5 pages (configurable)

## Requirements

- Node.js 16 or higher
- npm (comes with Node.js)

## Installation

1. Clone this repository:
   ```
   git clone <repository-url>
   cd lovable-docs-archiver
   ```

2. Install dependencies:
   ```
   npm install
   ```

## Usage

### Download the website

Run the following command to start the scraping process:

```
npm start
```

This will:
1. Visit the Lovable documentation homepage
2. Download all resources (HTML, CSS, JS, images, etc.)
3. Find and download linked pages (up to 5 pages by default)
4. Save everything in the `website` directory

### Preview the website locally

After the scraping is complete, you can view the website locally by running:

```
npm run serve
```

This will start an HTTP server and open your browser to view the downloaded website.

## Configuration

You can modify the following variables in `scrape_puppeteer.js`:

- `BASE_URL`: The starting URL for the scraper
- `ALLOWED_DOMAINS`: List of domains that the scraper is allowed to download from
- `MAX_PAGES`: Maximum number of pages to process (set to -1 for unlimited)
- `OUTPUT_DIR`: Directory where the website will be saved

## Notes

- The scraper preserves URL paths to ensure relative links work correctly
- Assets from external domains are saved in an `/assets/` directory
- The script handles query parameters in URLs to ensure all resources are saved correctly
