const fs = require('fs/promises');
const path = require('path');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { URL } = require('url');

// --- Configuration ---
const BASE_URL = 'https://docs.lovable.dev';
const ALLOWED_DOMAINS = [
    'docs.lovable.dev',
    'mintlify.b-cdn.net',
    'mintlify.s3.us-west-1.amazonaws.com'
];
const START_PATH = '/';
const OUTPUT_DIR = 'output';
const CSS_DIR = path.join(OUTPUT_DIR, 'css');
const JS_DIR = path.join(OUTPUT_DIR, 'js');
const ASSETS_DIR = path.join(OUTPUT_DIR, 'assets');
const FONTS_DIR = path.join(OUTPUT_DIR, 'fonts');
const WAIT_TIME = 3000; // Time to wait for page to fully load in ms
const MAX_PAGES = 5; // Maximum number of pages to process (set to -1 for unlimited)
const DEBUG = true; // Enable debug logging
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

// --- File and Directory Handling ---

/**
 * Creates the output directory if it doesn't exist.
 * @param {string} dirPath - The path to the directory.
 */
async function ensureOutputDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
        if (DEBUG) console.log(`Output directory "${dirPath}" ensured.`);
    } catch (error) {
        console.error(`Error creating output directory "${dirPath}":`, error);
        throw error;
    }
}

/**
 * Makes a filename safe by replacing forbidden characters
 * @param {string} url - Original URL to convert to a safe filename
 * @returns {string} Safe filename
 */
function makeSafeFilename(url) {
    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname;
        const pathname = parsedUrl.pathname;
        
        // Get the file name from the pathname
        let filename = path.basename(pathname);
        
        // If filename is empty or just a slash, use part of the pathname
        if (!filename || filename === '/') {
            const segments = pathname.split('/').filter(Boolean);
            filename = segments.length > 0 ? segments.join('-') : 'index';
            
            // Add extension based on URL analysis
            if (url.includes('.css') || url.endsWith('.css')) {
                filename += '.css';
            } else if (url.includes('.js') || url.endsWith('.js')) {
                filename += '.js';
            } else if (url.match(/\.(jpg|jpeg|png|gif|svg|webp|avif)(\?|$)/i)) {
                const match = url.match(/\.(jpg|jpeg|png|gif|svg|webp|avif)(\?|$)/i);
                filename += '.' + match[1];
            }
        }
        
        // Add hostname to ensure uniqueness across domains
        const safeHostname = hostname.replace(/\./g, '-');
        const safePathname = pathname.replace(/[^\w-]/g, '-').replace(/-+/g, '-');
        
        // Create a safe filename
        const safeFilename = `${safeHostname}${safePathname}-${filename}`.replace(/[^a-z0-9.-]/gi, '_').substring(0, 200);
        
        return safeFilename;
    } catch (error) {
        // For invalid URLs, create a hash-based filename
        return 'resource_' + Buffer.from(url).toString('base64').replace(/[^a-z0-9]/gi, '_').substring(0, 50);
    }
}

// --- URL and Resource Classification ---

/**
 * Determines if a URL is from an allowed domain
 * @param {string} url - The URL to check
 * @returns {boolean} - Whether the URL is from an allowed domain
 */
function isAllowedDomain(url) {
    try {
        const parsedUrl = new URL(url);
        return ALLOWED_DOMAINS.some(domain => parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain));
    } catch (e) {
        return false;
    }
}

/**
 * Categorize the resource URL by type
 * @param {string} url - The resource URL 
 * @returns {string} - The category (css, js, font, image, or other)
 */
function categorizeResource(url) {
    const lowerUrl = url.toLowerCase();
    const extension = lowerUrl.split('.').pop().split('?')[0];
    
    if (lowerUrl.endsWith('.css') || lowerUrl.includes('.css?') || extension === 'css') {
        return 'css';
    } else if (lowerUrl.endsWith('.js') || lowerUrl.includes('.js?') || extension === 'js' || lowerUrl.includes('/_next/static/chunks/')) {
        return 'js';
    } else if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) {
        return 'font';
    } else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif'].includes(extension) || 
              lowerUrl.includes('/images/') || lowerUrl.includes('/static/media/')) {
        return 'image';
    } else {
        return 'other';
    }
}

/**
 * Determines the appropriate directory for saving a resource
 * @param {string} category - The resource category
 * @returns {string} - Path to the appropriate directory
 */
function getDirectoryForResource(category) {
    switch (category) {
        case 'css': return CSS_DIR;
        case 'js': return JS_DIR;
        case 'font': return FONTS_DIR;
        case 'image': return ASSETS_DIR;
        default: return ASSETS_DIR;
    }
}

// --- Resource Extraction ---

/**
 * Extracts all resources from a page
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<Array<string>>} - Array of resource URLs
 */
async function extractPageResources(page) {
    // Set up a request interceptor to capture all resources
    const resourceRequests = new Set();
    page.on('request', request => {
        const url = request.url();
        if (isAllowedDomain(url) && 
            !url.startsWith('data:') && 
            !url.startsWith('blob:')) {
            resourceRequests.add(url);
        }
    });
    
    // Get resources from the DOM and other sources
    const resources = await page.evaluate(() => {
        const items = [];
        
        // Get all resources from the page
        document.querySelectorAll('link[rel="stylesheet"], script[src], img[src], source[src], image, svg image[href], svg use[href], svg [xlink\\:href]').forEach(el => {
            let url;
            if (el.tagName === 'LINK') url = el.href;
            else if (el.tagName === 'SCRIPT') url = el.src;
            else if (el.tagName === 'IMG' || el.tagName === 'SOURCE') url = el.src;
            else if (el.tagName === 'IMAGE' || (el.tagName === 'USE' && el.hasAttribute('href'))) url = el.getAttribute('href');
            else if (el.hasAttribute('xlink:href')) url = el.getAttribute('xlink:href');
            
            if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
                items.push(url);
            }
        });
        
        // Get all CSS background images
        const styles = Array.from(document.styleSheets || []);
        styles.forEach(styleSheet => {
            try {
                const rules = Array.from(styleSheet.cssRules || []);
                rules.forEach(rule => {
                    try {
                        if (rule.style && rule.style.backgroundImage) {
                            const urlMatch = /url\(['"]?([^'"]*?)['"]?\)/g.exec(rule.style.backgroundImage);
                            if (urlMatch && urlMatch[1] && !urlMatch[1].startsWith('data:')) {
                                items.push(new URL(urlMatch[1], window.location.href).href);
                            }
                        }
                    } catch (e) {
                        // Silently skip CORS issues with external stylesheets
                    }
                });
            } catch (e) {
                // Silently skip CORS issues with external stylesheets
            }
        });
        
        // Look for logo images specifically (they may be set via CSS or alternate patterns)
        document.querySelectorAll('[class*="logo"], [alt*="logo"], [id*="logo"]').forEach(el => {
            // Get background image if it exists
            const style = window.getComputedStyle(el);
            if (style.backgroundImage && style.backgroundImage !== 'none') {
                const urlMatch = /url\(['"]?([^'"]*?)['"]?\)/g.exec(style.backgroundImage);
                if (urlMatch && urlMatch[1] && !urlMatch[1].startsWith('data:')) {
                    items.push(new URL(urlMatch[1], window.location.href).href);
                }
            }
            
            // Get img inside this element if it exists
            const img = el.querySelector('img');
            if (img && img.src && !img.src.startsWith('data:')) {
                items.push(img.src);
            }
        });
        
        // Also look for dynamically loaded resources in inline scripts
        document.querySelectorAll('script:not([src])').forEach(script => {
            const content = script.textContent || '';
            
            // Look for Next.js chunk patterns
            const nextJsChunkPattern = /\/_next\/static\/chunks\/[^"'\s]+/g;
            let match;
            while ((match = nextJsChunkPattern.exec(content)) !== null) {
                if (match[0]) items.push(new URL(match[0], window.location.href).href);
            }
            
            // Look for other JavaScript/CSS files
            const resourcePattern = /(['"])(https?:\/\/[^'"]+\.(js|css)|\/[^'"]+\.(js|css))['"]/g;
            while ((match = resourcePattern.exec(content)) !== null) {
                if (match[2]) items.push(new URL(match[2], window.location.href).href);
            }
            
            // Look for image files - be extra thorough with SVG files
            const imagePattern = /(['"])(https?:\/\/[^'"]+\.(png|jpg|jpeg|gif|svg|webp|avif)|\/[^'"]+\.(png|jpg|jpeg|gif|svg|webp|avif))['"]/g;
            while ((match = imagePattern.exec(content)) !== null) {
                if (match[2]) items.push(new URL(match[2], window.location.href).href);
            }
            
            // Look for Mintlify CDN references
            const mintlifyCdnPattern = /(['"])(https?:\/\/mintlify[^'"]+)['"]/g;
            while ((match = mintlifyCdnPattern.exec(content)) !== null) {
                if (match[2]) items.push(new URL(match[2], window.location.href).href);
            }
            
            // Look for common image directory patterns
            const imageDirPattern = /(['"])(https?:\/\/[^'"]+\/images\/[^'"]+|\/images\/[^'"]+)['"]/g;
            while ((match = imageDirPattern.exec(content)) !== null) {
                if (match[2]) items.push(new URL(match[2], window.location.href).href);
            }
        });
        
        // Get Next.js data if available
        const nextData = document.getElementById('__NEXT_DATA__');
        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                if (data.buildId) {
                    items.push(new URL(`/_next/static/${data.buildId}/_buildManifest.js`, window.location.href).href);
                    items.push(new URL(`/_next/static/${data.buildId}/_ssgManifest.js`, window.location.href).href);
                }
            } catch (e) {
                console.error('Error parsing Next.js data:', e);
            }
        }
        
        return [...new Set(items)]; // Return unique items
    });
    
    // Add resources from intercepted requests
    resources.push(...resourceRequests);
    
    // Make resources unique
    const uniqueResources = [...new Set(resources)];
    
    if (DEBUG) {
        console.log(`Found ${uniqueResources.length} resources on the page`);
    }
    
    return uniqueResources;
}

// --- Navigation Link Extraction ---

/**
 * Extracts all internal navigation links from a page
 * @param {Object} page - Puppeteer page object
 * @param {string} baseUrl - Base URL of the site
 * @returns {Promise<Array<Object>>} - Array of navigation link objects
 */
async function extractNavigationLinks(page, baseUrl) {
    const internalLinks = await page.evaluate((baseUrl) => {
        const links = [];
        document.querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href');
            if (!href) return;
            
            // Skip anchor links, emails, tel links
            if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
                return;
            }
            
            // Parse the link to determine if it's internal
            let fullUrl;
            if (href.startsWith('http://') || href.startsWith('https://')) {
                // Skip external links
                if (!href.startsWith(baseUrl)) return;
                fullUrl = href;
            } else if (href.startsWith('/')) {
                // Site-root-relative URL
                fullUrl = baseUrl + href;
            } else {
                // Relative URL - resolve against current page
                const currentPath = window.location.pathname;
                const currentDir = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
                fullUrl = baseUrl + currentDir + href;
            }
            
            // Extract path from the full URL
            try {
                const urlObj = new URL(fullUrl);
                // Skip if it's an asset
                const ext = urlObj.pathname.split('.').pop().toLowerCase();
                if (['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'avif'].includes(ext)) {
                    return;
                }
                
                // For navigation links, collect both the full URL and the path
                links.push({
                    url: fullUrl,
                    path: urlObj.pathname,
                    text: a.textContent.trim() || '',
                    title: a.getAttribute('title') || ''
                });
            } catch (e) {
                console.error('Error parsing URL:', e);
            }
        });
        return links;
    }, baseUrl);
    
    return internalLinks;
}

// --- Resource Downloading ---

/**
 * Downloads a single resource
 * @param {string} url - The URL to download
 * @param {string} category - The resource category
 * @returns {Promise<{filePath: string, success: boolean}>} - Result with local file path
 */
async function downloadResource(url, category) {
    try {
        const directory = getDirectoryForResource(category);
        const filename = makeSafeFilename(url);
        const filePath = path.join(directory, filename);
        
        // Check if file already exists to avoid duplicate downloads
        try {
            await fs.access(filePath);
            if (DEBUG) console.log(`File already exists: ${filePath}`);
            return { filePath, success: true, alreadyExists: true };
        } catch (e) {
            // File doesn't exist, continue with download
        }
        
        // Determine if we need text or binary data
        const isCssOrJs = ['css', 'js'].includes(category);
        const responseType = isCssOrJs ? 'text' : 'arraybuffer';
        
        // Download the resource
        const response = await axios.get(url, {
            responseType,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': '*/*',
                'Referer': BASE_URL
            },
            timeout: 15000,
            maxRedirects: 5
        });
        
        // Save the resource
        await fs.writeFile(filePath, response.data);
        if (DEBUG) console.log(`Downloaded ${url} to ${filePath}`);
        
        return { filePath, success: true };
    } catch (error) {
        console.error(`Error downloading ${url}: ${error.message}`);
        return { filePath: null, success: false, error: error.message };
    }
}

/**
 * Downloads all resources collected from pages
 * @param {Array<Object>} pages - Array of page data objects with resources
 * @returns {Promise<{success: number, failed: number}>} - Download statistics
 */
async function downloadAllResources(pages) {
    console.log("\nStarting resource downloads...");
    
    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    let totalResources = 0;
    
    // First, count total resources
    for (const page of pages) {
        for (const category of ['css', 'js', 'images', 'fonts', 'other']) {
            totalResources += page.resources[category].length;
        }
    }
    
    console.log(`Found ${totalResources} total resources to download`);
    
    // Process each page's resources
    for (const page of pages) {
        console.log(`\nDownloading resources for page: ${page.url}`);
        
        // Process each resource category
        for (const category of ['css', 'js', 'images', 'fonts', 'other']) {
            const resources = page.resources[category];
            if (resources.length === 0) continue;
            
            console.log(`Downloading ${resources.length} ${category} resources...`);
            
            // Process resources in batches to avoid overwhelming the server
            const batchSize = 5;
            for (let i = 0; i < resources.length; i += batchSize) {
                const batch = resources.slice(i, i + batchSize);
                
                const promises = batch.map(resource => {
                    return downloadResource(resource.url, resource.category).then(result => {
                        if (result.success) {
                            resource.localPath = path.relative(OUTPUT_DIR, result.filePath);
                            resource.downloaded = true;
                            successCount++;
                        } else {
                            resource.downloaded = false;
                            resource.error = result.error;
                            failedCount++;
                        }
                        processedCount++;
                        
                        // Print progress every 20 resources
                        if (processedCount % 20 === 0 || processedCount === totalResources) {
                            console.log(`Download progress: ${processedCount}/${totalResources} (${Math.round(processedCount/totalResources*100)}%)`);
                        }
                        
                        return result;
                    });
                });
                
                await Promise.all(promises);
            }
        }
    }
    
    console.log("\nResource downloads complete.");
    console.log(`Successfully downloaded: ${successCount}`);
    console.log(`Failed downloads: ${failedCount}`);
    
    return { success: successCount, failed: failedCount };
}

// --- Page Processing ---

/**
 * Processes a single page to extract all data
 * @param {Object} page - Puppeteer page object
 * @param {string} urlPath - Path to process
 * @param {Set<string>} processedPaths - Already processed paths
 * @param {Set<string>} pathsToProcess - Paths to process
 * @returns {Promise<Object|null>} - Page data or null if already processed
 */
async function processPage(page, urlPath, processedPaths, pathsToProcess) {
    const fullUrl = BASE_URL + urlPath;
    
    console.log(`Processing: ${fullUrl}`);

    // Skip if already processed
    if (processedPaths.has(urlPath)) {
        console.log(`Already processed: ${urlPath}`);
        return null;
    }
    
    // Mark as processed
    processedPaths.add(urlPath);
    
    // Initialize data structure for this page
    const pageData = {
        url: fullUrl,
        path: urlPath,
        title: '',
        resources: {
            css: [],
            js: [],
            images: [],
            fonts: [],
            other: []
        },
        navigationLinks: []
    };
    
    try {
        // Navigate to the page
        console.log(`Navigating to: ${fullUrl}`);
        await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait a bit more for dynamic content
        await new Promise(resolve => setTimeout(resolve, WAIT_TIME));
        console.log(`Finished waiting for dynamic content`);
        
        // Get the page title
        pageData.title = await page.title();
        console.log(`Page title: ${pageData.title}`);
        
        // Step 1: Extract all resources
        const resourceUrls = await extractPageResources(page);
        
        // Step 2: Extract all navigation links
        const navigationLinks = await extractNavigationLinks(page, BASE_URL);
        pageData.navigationLinks = navigationLinks;
        
        // Add links to processing queue
        for (const link of navigationLinks) {
            if (!processedPaths.has(link.path) && !pathsToProcess.has(link.path)) {
                console.log(`Queueing: ${link.path}`);
                pathsToProcess.add(link.path);
            }
        }
        
        // Process and categorize resources (just information, not downloading yet)
        for (const url of resourceUrls) {
            if (isAllowedDomain(url)) {
                const category = categorizeResource(url);
                
                // Store resource in appropriate category array
                const resource = {
                    url: url,
                    category: category,
                    localPath: null // Will be filled after download
                };
                
                switch(category) {
                    case 'css': 
                        pageData.resources.css.push(resource);
                        break;
                    case 'js': 
                        pageData.resources.js.push(resource);
                        break;
                    case 'image': 
                        pageData.resources.images.push(resource);
                        break;
                    case 'font': 
                        pageData.resources.fonts.push(resource);
                        break;
                    default: 
                        pageData.resources.other.push(resource);
                }
            }
        }
        
        return pageData;
        
    } catch (error) {
        console.error(`Error processing ${fullUrl}:`, error.message);
        console.error(error.stack);
        
        // Still return the page data but mark it as error
        pageData.error = error.message;
        return pageData;
    }
}

// --- Main Execution ---

/**
 * Main execution function that orchestrates the entire scraping process
 */
async function main() {
    const maxPages = MAX_PAGES;
    console.log(`Starting scraper with max pages set to: ${maxPages < 0 ? 'unlimited' : maxPages}`);
    
    // Step 1: Create output directories
    await ensureOutputDir(OUTPUT_DIR);
    await ensureOutputDir(CSS_DIR);
    await ensureOutputDir(JS_DIR);
    await ensureOutputDir(ASSETS_DIR);
    await ensureOutputDir(FONTS_DIR);
    
    // Step 2: Initialize data collection object
    const collectedData = {
        baseUrl: BASE_URL,
        startPath: START_PATH,
        timestamp: new Date().toISOString(),
        outputDir: OUTPUT_DIR,
        pages: [],
        allNavigationPaths: new Set(),
        stats: {
            totalPages: 0,
            pagesWithErrors: 0,
            totalResources: {
                css: 0,
                js: 0,
                images: 0,
                fonts: 0,
                other: 0
            },
            downloadStatus: {
                success: 0,
                failed: 0
            }
        }
    };
    
    // Step 3: Launch browser and collect page data
    console.log("\n=== Phase 1: Collecting Page Data ===");
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    
    try {
        // Create a single page to reuse
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(60000);
        
        // Sets to track pages
        const processedPaths = new Set();
        const pathsToProcess = new Set([START_PATH]);
        
        // Process pages up to the limit
        let processedCount = 0;
        
        // Process all pages one by one
        while (pathsToProcess.size > 0 && (maxPages < 0 || processedCount < maxPages)) {
            // Get next path
            const currentPath = Array.from(pathsToProcess)[0];
            pathsToProcess.delete(currentPath);
            
            // Skip if already processed
            if (processedPaths.has(currentPath)) {
                continue;
            }
            
            // Process the page
            const pageData = await processPage(page, currentPath, processedPaths, pathsToProcess);
            
            if (pageData) {
                collectedData.pages.push(pageData);
                
                // Update statistics
                collectedData.stats.totalPages++;
                if (pageData.error) {
                    collectedData.stats.pagesWithErrors++;
                }
                
                // Update resource counts
                collectedData.stats.totalResources.css += pageData.resources.css.length;
                collectedData.stats.totalResources.js += pageData.resources.js.length;
                collectedData.stats.totalResources.images += pageData.resources.images.length;
                collectedData.stats.totalResources.fonts += pageData.resources.fonts.length;
                collectedData.stats.totalResources.other += pageData.resources.other.length;
                
                // Add unique paths to the set of all navigation paths
                pageData.navigationLinks.forEach(link => {
                    collectedData.allNavigationPaths.add(link.path);
                });
                
                processedCount++;
                
                // Show progress
                console.log(`\nProgress: ${processedCount}/${maxPages < 0 ? '∞' : maxPages} pages processed, ${pathsToProcess.size} pages in queue\n`);
            }
        }
        
        console.log("\nFinished collecting page data.");
        console.log(`Processed ${processedCount} pages out of ${maxPages < 0 ? 'unlimited' : maxPages}.`);
        
    } finally {
        // Close browser after all pages are processed
        await browser.close();
        console.log("Browser closed.");
    }
    
    // Step 4: Download all resources (after browser is closed)
    console.log("\n=== Phase 2: Downloading Resources ===");
    const downloadStats = await downloadAllResources(collectedData.pages);
    
    // Update stats with download information
    collectedData.stats.downloadStatus = downloadStats;
    
    // Convert Set to Array for JSON serialization
    collectedData.allNavigationPaths = Array.from(collectedData.allNavigationPaths);
    
    // Calculate total resources
    const totalResources = 
        collectedData.stats.totalResources.css + 
        collectedData.stats.totalResources.js + 
        collectedData.stats.totalResources.images + 
        collectedData.stats.totalResources.fonts + 
        collectedData.stats.totalResources.other;
        
    collectedData.stats.totalResourcesCount = totalResources;
    
    // Step 5: Save the collected data to a JSON file
    console.log("\n=== Phase 3: Saving Results ===");
    const outputFile = path.join(OUTPUT_DIR, 'collected-data.json');
    await fs.writeFile(outputFile, JSON.stringify(collectedData, null, 2));
    console.log(`Saved collected data to ${outputFile}`);
    
    console.log("\n=== Scraping Process Complete ===");
    console.log(`Pages processed: ${collectedData.stats.totalPages}`);
    console.log(`Resources found: ${totalResources}`);
    console.log(`Resources downloaded: ${downloadStats.success}`);
    console.log(`Failed downloads: ${downloadStats.failed}`);
}

// Check if required packages are installed
try {
    require('puppeteer');
    require('axios');
} catch (e) {
    console.error("Missing required packages. Please run 'npm install puppeteer axios' before running this script.");
    process.exit(1);
}

// Run the script
main().catch(error => {
    console.error("\nAn unexpected error occurred during data collection:", error);
    process.exit(1);
});