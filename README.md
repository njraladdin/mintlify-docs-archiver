# Lovable Docs Archiver

A tool to archive documentation websites by crawling a domain, downloading all pages and resources, and extracting structured data.

## Features

- Crawls and archives entire documentation websites
- Preserves the site structure and assets
- Handles essential external resources automatically
- Extracts structured data from Next.js-based websites
- Creates an offline-ready archive that can be browsed locally

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/yourusername/lovable-docs-archiver.git
   cd lovable-docs-archiver
   ```

2. Install dependencies:
   ```
   npm install
   ```

## Usage

Run the archiver with a domain to archive:

```
node main.js [domain] [maxPages]
```

### Arguments

- `domain`: The domain to archive (default: docs.lovable.dev if not specified)
- `maxPages`: Maximum number of pages to process (default: 5, use -1 for unlimited)

### Examples

Archive with default settings (docs.lovable.dev with 5 pages max):
```
node main.js
```

Archive a specific domain with default page limit:
```
node main.js docs.lovable.dev
```

Archive with up to 10 pages:
```
node main.js docs.lovable.dev 10
```

Archive with unlimited pages:
```
node main.js docs.lovable.dev -1
```

## Output

The tool creates the following directory structure:
```
output/
└── <domain>/
    ├── website/    (archived website)
    └── json_data/  (extracted JSON data)
```

To view the archived website locally:
```
npx http-server output/<domain>/website -o
```

## How It Works

1. The tool starts from the specified domain's homepage
2. It crawls all linked pages within the domain and essential CDN domains
3. All HTML, CSS, JS, images, and other resources are downloaded and saved
4. The tool processes HTML files to ensure URLs work correctly in the archive
5. Structured data is extracted from Next.js-based websites
6. A final summary of the archive is saved in the json_data directory

## Requirements

- Node.js 16 or higher
- NPM 7 or higher
- Puppeteer (automatically installed with dependencies)

## License

MIT
