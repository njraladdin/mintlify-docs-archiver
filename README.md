# Lovable Docs Archiver

A tool to archive documentation websites by crawling a domain, downloading all pages and resources, and extracting structured data.

## Features

- Crawls and archives entire documentation websites
- Preserves the site structure and assets
- Handles essential external resources automatically
- Extracts structured data from Next.js-based websites
- Creates an offline-ready archive that can be browsed locally
- Includes a convenience script in the output directory to preview the site

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/njraladdin/mintlify-docs-archiver.git
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

The tool creates an `output` directory containing:
```
output/
├── [HTML, CSS, JS files and other assets]  (The archived website)
├── json_data/                              (Extracted structured JSON data)
└── preview-website.bat                     (Script to easily preview the site)
```

### Viewing the Archived Website

#### Option 1: Using the preview script in the output directory (Windows, Easiest)

1. Navigate to the `output` folder
2. **Double-click** on the `preview-website.bat` file

This will start a web server on port 8095 right from the output directory. You can then view the archived website at:
```
http://localhost:8095
```

#### Option 2: Using the included server script from the project root (Windows)

1. **Double-click** on the `start-server.bat` file in Windows Explorer
   
   OR
   
2. Run the batch file from Command Prompt or PowerShell:
   ```
   .\start-server.bat
   ```

This will start a web server on port 8095. You can then view the archived website at:
```
http://localhost:8095
```

#### Option 3: Using Node.js directly

If you prefer to run the server manually:

```
npx http-server output -p 8095
```

Then open your browser and navigate to:
```
http://localhost:8095
```

If you prefer to install http-server globally:
```
npm install -g http-server
http-server output -p 8095
```

## How It Works

1. The tool starts from the specified domain's homepage
2. It crawls all linked pages within the domain and essential CDN domains
3. All HTML, CSS, JS, images, and other resources are downloaded and saved
4. The tool processes HTML files to ensure URLs work correctly in the archive
5. Structured data is extracted from Next.js-based websites
6. A preview script is included in the output folder for easy viewing
7. A final summary of the archive is saved in the json_data directory

## Requirements

- Node.js 16 or higher
- NPM 7 or higher
- Puppeteer (automatically installed with dependencies)

## License

MIT
