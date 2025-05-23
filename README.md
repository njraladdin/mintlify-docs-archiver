# Mintlify Docs Archiver

A tool that downloads and archives Mintlify-powered documentation websites for offline viewing.

## What It Does

Mintlify Docs Archiver crawls documentation websites, saves all pages and resources locally, and preserves the original site structure. It creates a complete offline copy that can be browsed just like the live site.

## How It Works

1. Crawls pages starting from the specified domain
2. Downloads HTML, CSS, JS, images and other assets
3. Processes files to fix URLs for offline viewing
4. Extracts structured data from Next.js-based sites
5. Creates a preview script for easy local browsing

## Requirements

- Node.js 16 or higher

## Installation

```
git clone https://github.com/njraladdin/mintlify-docs-archiver.git
cd mintlify-docs-archiver
npm install
```

## Usage

Basic command format:

```
node main.js [domain] [maxPages]
```

Parameters:
- `domain`: Site to archive (default: docs.xxxx.com)
- `maxPages`: Maximum pages to process (default: 5, use -1 for unlimited)

## Example Usage

Archive docs.xxxx.com with unlimited pages:

```
node main.js docs.xxxx.com -1
```

## Output

The tool creates an `output` directory with:

```
output/
├── [HTML, CSS, JS files and assets]  (The archived website)
├── json_data/                        (Extracted data)
├── preview-website.bat               (Preview script for Windows)
└── preview-website.command           (Preview script for macOS)
```

## Previewing the Website

To view the archived site:

- **On Windows:**
  1. Navigate to the `output` folder
  2. Double-click `preview-website.bat`
  3. Open `http://localhost:8095` in your browser

- **On macOS:**
  1. Navigate to the `output` folder
  2. Double-click `preview-website.command` (you may need to run `chmod +x preview-website.command` the first time)
  3. Open `http://localhost:8095` in your browser

Alternatively, you can run the following command from the `output` directory on any platform:

```
npx http-server . -p 8095 -o
```

## License

MIT