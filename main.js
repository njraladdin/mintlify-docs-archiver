/**
 * Mintlify Docs Archiver - Main Entry Point
 * 
 * This script serves as the entry point for the Mintlify Docs Archiver tool.
 * It parses command-line arguments and runs the scraper with the specified domain.
 * 
 * Usage:
 *   node main.js [domain] [maxPages]
 * 
 * Examples:
 *   node main.js                        (uses default domain: docs.xxxx.com)
 *   node main.js docs.xxxx.com
 *   node main.js docs.xxxx.com 10
 *   node main.js docs.xxxx.com -1    (unlimited pages)
 * 
 * Arguments:
 *   domain           - The main domain to archive (default: docs.xxxx.com)
 *   maxPages         - Maximum number of pages to process (default: 5, use -1 for unlimited)
 */

const { runScraper } = require('./scraper');

// Parse command line arguments
const args = process.argv.slice(2);

// Extract arguments with default for domain
const domain = args.length > 0 ? args[0] : 'docs.xxxx.com'; // default domain
const maxPages = args.length > 1 ? parseInt(args[1], 10) : -1; // default max pages

// Validate domain
if (!domain.includes('.')) {
  console.error('Error: Invalid domain format. Domain should include a TLD (e.g. example.com)');
  process.exit(1);
}

// Validate maxPages
if (isNaN(maxPages) && args.length > 1) {
  console.error('Error: maxPages must be a number');
  process.exit(1);
}

console.log(`
╭───────────────────────────────╮
│  Mintlify Docs Archiver       │
│  Starting archive process     │
╰───────────────────────────────╯
`);

console.log(`Domain to archive: ${domain}`);
console.log(`Max pages: ${maxPages === -1 ? 'Unlimited' : maxPages}`);
console.log('\n');

// Run the scraper
runScraper({domain, maxPages}).catch(error => {
  console.error('Error running scraper:', error);
  process.exit(1);
});

