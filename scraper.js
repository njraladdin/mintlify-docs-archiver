const puppeteer = require('puppeteer');
const fs = require('fs');
const fsp = fs.promises; // Alias for fs.promises for async file operations
const path = require('path');
const url = require('url');
// Import the JSON extractor module
const jsonExtractor = require('./jsonExtractor');

// Function to run the scraper with a specified domain
async function runScraper({domain = 'docs.cursor.com', maxPages = 5}) {
    // Configure URL and domains based on input
    const BASE_URL = `https://${domain}`;
    
    // Default allowed domains
    const ALLOWED_DOMAINS = [
        domain,
        'mintlify.b-cdn.net',
        'mintlify.s3.us-west-1.amazonaws.com',
        'cdn.jsdelivr.net',
        'cdn.jsdelivr.net'
    ];

    // Parse domain from BASE_URL
    const BASE_DOMAIN = domain;

    // Simplified directory structure - everything goes directly in OUTPUT_DIR
    const OUTPUT_DIR = 'output'; // Main output directory

    const MAX_PAGES = maxPages; // Maximum number of pages to process (set to -1 for unlimited)

    // Set to keep track of processed URLs
    const processedPages = new Set();
    const processedResources = new Set();
    const pagesToProcess = [BASE_URL];

    // Data collection object to track pages and metadata for JSON extraction
    const collectedData = {
        pages: [],
        stats: {
            processedPages: 0,
            extractedResources: 0,
            extractedNextJsData: 0
        }
    };

    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Helper function to determine if a URL is allowed to be processed
    function isAllowedUrl(urlString) {
        try {
            const parsedUrl = new URL(urlString);
            return ALLOWED_DOMAINS.some(domain => parsedUrl.hostname === domain);
        } catch (e) {
            return false;
        }
    }

    // Helper function to create a safe file path
    function safePath(inputPath) {
        // Simple but effective approach:
        // 1. Replace encoded brackets %5B and %5D with _bracket_ format
        // 2. Replace literal brackets [ and ] with _bracket_ format
        // 3. Replace other problematic characters

        let safePath = inputPath;
        
        // Handle encoded brackets
        safePath = safePath.replace(/%5B/g, '_lbracket_').replace(/%5D/g, '_rbracket_');
        
        // Handle literal brackets
        safePath = safePath.replace(/\[/g, '_lbracket_').replace(/\]/g, '_rbracket_');
        
        // Handle other potentially problematic characters
        safePath = safePath.replace(/[<>:"\\|?*]/g, '_');
        
        return safePath;
    }

    // Helper function to get the relative path from a URL
    function getRelativePath(urlString) {
        try {
            const parsedUrl = new URL(urlString);
            let relativePath = parsedUrl.pathname;
            
            // Handle paths for different domains
            if (parsedUrl.hostname !== domain) {
                relativePath = `/assets/${parsedUrl.hostname}${relativePath}`;
            }
            
            // Make path safe for filesystem
            relativePath = safePath(relativePath);
            
            // Handle query parameters for resources that need them
            if (parsedUrl.search && (urlString.includes('.css') || urlString.includes('.js') || urlString.includes('.png') || urlString.includes('.jpg') || urlString.includes('.svg'))) {
                // Replace all non-alphanumeric characters with underscores for safety
                const safeQueryString = parsedUrl.search.replace(/[^a-z0-9]/gi, '_');
                relativePath = `${relativePath}${safeQueryString}`;
            }
            
            return relativePath;
        } catch (e) {
            console.error('Error parsing URL:', urlString, e);
            return null;
        }
    }

    // Helper function to normalize URLs by removing hash fragments
    function normalizeUrl(urlString) {
        try {
            const url = new URL(urlString);
            // Remove hash fragment
            url.hash = '';
            return url.toString();
        } catch (e) {
            console.error('Error normalizing URL:', urlString, e);
            return urlString;
        }
    }

    // Function to download a resource
    async function downloadResource(resourceUrl, baseUrl) {
        // Normalize the URL to remove hash fragments
        const normalizedUrl = normalizeUrl(resourceUrl);
        
        if (processedResources.has(normalizedUrl) || !isAllowedUrl(normalizedUrl)) {
            return;
        }
        
        try {
            processedResources.add(normalizedUrl);
            
            // Resolve relative URLs against the base URL
            const absoluteUrl = new URL(normalizedUrl, baseUrl).href;
            const relativePath = getRelativePath(absoluteUrl);
            
            if (!relativePath) return;
            
            // Create the local file path - now directly in OUTPUT_DIR
            let localPath = path.join(OUTPUT_DIR, relativePath);
            
            // Handle paths that end with / or don't have an extension (treat as directories)
            if (localPath.endsWith('/') || (!path.extname(localPath) && !localPath.includes('.'))) {
                localPath = path.join(localPath, 'index.html');
            }
            
            // Create directory if it doesn't exist - ENSURE THIS COMPLETES BEFORE WRITING
            const dir = path.dirname(localPath);
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (dirError) {
                console.error(`Error creating directory ${dir}:`, dirError);
                return; // Don't proceed if directory creation fails
            }
            
            // Check if the path is a directory and adjust if needed
            if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
                localPath = path.join(localPath, 'index.html');
                // Create subdirectory if needed
                try {
                    fs.mkdirSync(path.dirname(localPath), { recursive: true });
                } catch (subDirError) {
                    console.error(`Error creating subdirectory for ${localPath}:`, subDirError);
                    return;
                }
            }
            
            // Download the resource
            console.log(`Downloading: ${absoluteUrl} -> ${localPath}`);
            
            let response;
            try {
                response = await fetch(absoluteUrl);
            } catch (fetchError) {
                console.error(`Failed to fetch ${absoluteUrl}:`, fetchError.message);
                return;
            }
            
            if (!response.ok) {
                console.error(`Failed to download ${absoluteUrl}: ${response.status} ${response.statusText}`);
                return;
            }
            
            // Write the file with proper error handling
            try {
                if (response.headers.get('content-type')?.includes('text/html')) {
                    let text = await response.text();
                    // Also update URLs in HTML content for asset files
                    text = updateHtmlUrls(text);
                    fs.writeFileSync(localPath, text);
                } else {
                    const buffer = await response.arrayBuffer();
                    fs.writeFileSync(localPath, Buffer.from(buffer));
                }
            } catch (writeError) {
                console.error(`Error writing file ${localPath}:`, writeError);
                // If write fails due to directory not existing, try creating again
                if (writeError.code === 'ENOENT') {
                    try {
                        fs.mkdirSync(path.dirname(localPath), { recursive: true });
                        // Try writing again
                        if (response.headers.get('content-type')?.includes('text/html')) {
                            let text = await response.text();
                            // Also update URLs in HTML content for asset files
                            text = updateHtmlUrls(text);
                            fs.writeFileSync(localPath, text);
                        } else {
                            const buffer = await response.arrayBuffer();
                            fs.writeFileSync(localPath, Buffer.from(buffer));
                        }
                    } catch (retryError) {
                        console.error(`Failed retry writing ${localPath}:`, retryError);
                    }
                }
            }

            // Track stats for extracted resources
            collectedData.stats.extractedResources++;
        } catch (error) {
            console.error(`Error downloading ${resourceUrl}:`, error);
        }
    }

    // Function to update URLs in HTML content
    function updateHtmlUrls(content) {
        // Process src and href attributes - standard HTML attributes
        let updatedContent = content.replace(
            /(src|href|poster|data|background|srcset|content)=["']([^"']+)["']/gi, 
            (match, attr, url) => {
                // Skip data URLs
                if (url.startsWith('data:')) {
                    return match;
                }
                
                try {
                    // Handle srcset attribute specially
                    if (attr.toLowerCase() === 'srcset') {
                        // Split srcset by commas, considering the URL might have commas in query params
                        const srcSetParts = url.split(/\s*,\s*/);
                        const processedParts = srcSetParts.map(part => {
                            // Extract URL and any descriptors like 2x or 100w
                            const [srcUrl, ...descriptors] = part.trim().split(/\s+/);
                            
                            // Process the URL part
                            if (srcUrl.startsWith('http:') || srcUrl.startsWith('https:') || srcUrl.startsWith('//')) {
                                const absoluteUrl = srcUrl.startsWith('//') ? `https:${srcUrl}` : srcUrl;
                                if (isAllowedUrl(absoluteUrl)) {
                                    const relativePath = getRelativePath(absoluteUrl);
                                    if (relativePath) {
                                        return [relativePath, ...descriptors].join(' ');
                                    }
                                }
                            }
                            
                            // If we can't convert, return the original part
                            return part;
                        });
                        
                        return `${attr}="${processedParts.join(', ')}"`;
                    }
                    
                    // Handle absolute URLs (including protocol-relative URLs)
                    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('//')) {
                        const absoluteUrl = url.startsWith('//') ? `https:${url}` : url;
                        if (isAllowedUrl(absoluteUrl)) {
                            const relativePath = getRelativePath(absoluteUrl);
                            if (relativePath) {
                                return `${attr}="${relativePath}"`;
                            }
                        }
                        return match;
                    }
                    
                    // Handle relative URLs 
                    const urlParts = url.split('/');
                    const safeUrlParts = urlParts.map(part => safePath(part));
                    let safeUrl = safeUrlParts.join('/');
                    
                    // For href attributes, ensure proper HTML extension
                    if (attr === 'href' && !safeUrl.includes('.') && !safeUrl.endsWith('/')) {
                        safeUrl = `${safeUrl}.html`;
                    }
                    
                    return `${attr}="${safeUrl}"`;
                } catch (error) {
                    console.error(`Error processing URL in attribute ${attr}: ${url}`, error);
                    return match;
                }
            }
        );
        
        // Also check for URLs in inline styles
        updatedContent = updatedContent.replace(
            /style=["']([^"']*)url\(['"]?([^'")]+)['"]?\)([^"']*)['"]/gi,
            (match, stylePrefix, url, styleSuffix) => {
                // Skip data URLs
                if (url.startsWith('data:')) {
                    return match;
                }
                
                try {
                    // Handle absolute URLs
                    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('//')) {
                        const absoluteUrl = url.startsWith('//') ? `https:${url}` : url;
                        if (isAllowedUrl(absoluteUrl)) {
                            const relativePath = getRelativePath(absoluteUrl);
                            if (relativePath) {
                                return `style="${stylePrefix}url('${relativePath}')${styleSuffix}"`;
                            }
                        }
                        return match;
                    }
                    
                    // Handle relative URLs
                    const urlParts = url.split('/');
                    const safeUrlParts = urlParts.map(part => safePath(part));
                    let safeUrl = safeUrlParts.join('/');
                    
                    return `style="${stylePrefix}url('${safeUrl}')${styleSuffix}"`;
                } catch (error) {
                    console.error(`Error processing URL in style: ${url}`, error);
                    return match;
                }
            }
        );
        
        return updatedContent;
    }

    // Function to process a page and extract all resources
    async function processPage(pageUrl, browser) {
        // Normalize the URL to remove the hash fragment
        const normalizedUrl = normalizeUrl(pageUrl);
        
        if (processedPages.has(normalizedUrl) || !isAllowedUrl(normalizedUrl)) {
            if (pageUrl !== normalizedUrl) {
                console.log(`\nSkipping page with hash fragment: ${pageUrl}`);
                console.log(`Already processed as: ${normalizedUrl}`);
            } else {
                console.log(`\nSkipping already processed page: ${pageUrl}`);
            }
            return [];
        }
        
        console.log(`\nProcessing page: ${pageUrl}`);
        if (pageUrl !== normalizedUrl) {
            console.log(`Normalized to: ${normalizedUrl}`);
        }
        processedPages.add(normalizedUrl);
        
        try {
            // Open a new page
            const page = await browser.newPage();
            
            // Enable request interception to capture resource URLs
            await page.setRequestInterception(true);
            
            // Handle resource requests
            page.on('request', async (request) => {
                // Continue with the request without modifying it
                await request.continue();
            });
            
            // Collect resource URLs
            const resources = new Set();
            page.on('response', async (response) => {
                const responseUrl = response.url();
                if (isAllowedUrl(responseUrl)) {
                    resources.add(responseUrl);
                }
            });
            
            // Navigate to the page with a timeout
            await page.goto(pageUrl, { 
                waitUntil: 'networkidle2', 
                timeout: 60000 
            });
            
            // Get the content of the page
            let content = await page.content();
            
            // Update URLs in HTML content to match our file path encoding
            content = updateHtmlUrls(content);
            
            // Save the HTML file
            const relativePath = getRelativePath(normalizedUrl);
            let localPath = path.join(OUTPUT_DIR, relativePath || '');
            
            // Handle paths that end with / or don't have an extension (treat as directories)
            if (localPath.endsWith('/') || (!path.extname(localPath) && !localPath.includes('.'))) {
                localPath = path.join(localPath, 'index.html');
            }
            
            // Create directory if it doesn't exist - ENSURE THIS COMPLETES BEFORE WRITING
            const dir = path.dirname(localPath);
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (dirError) {
                console.error(`Error creating directory ${dir}:`, dirError);
                await page.close();
                return []; // Don't proceed if directory creation fails
            }
            
            // Wait a moment to ensure directory creation has completed
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Check if the path is a directory and adjust if needed
            if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
                localPath = path.join(localPath, 'index.html');
                // Create subdirectory if needed
                try {
                    fs.mkdirSync(path.dirname(localPath), { recursive: true });
                } catch (subDirError) {
                    console.error(`Error creating subdirectory for ${localPath}:`, subDirError);
                    await page.close();
                    return [];
                }
            }
            
            console.log(`Saving HTML: ${pageUrl} -> ${localPath}`);
            try {
                fs.writeFileSync(localPath, content);
                
                // Add this page to the collectedData for later JSON extraction
                collectedData.pages.push({
                    url: pageUrl,
                    path: new URL(pageUrl).pathname,
                    htmlFile: path.relative(OUTPUT_DIR, localPath).replace(/\\/g, '/')
                });
                
            } catch (writeError) {
                console.error(`Error writing file ${localPath}:`, writeError);
                // If write fails due to directory not existing, try creating again
                if (writeError.code === 'ENOENT') {
                    try {
                        fs.mkdirSync(path.dirname(localPath), { recursive: true });
                        // Try writing again after ensuring directory exists
                        fs.writeFileSync(localPath, content);
                        
                        // Add this page to the collectedData for later JSON extraction
                        collectedData.pages.push({
                            url: pageUrl,
                            path: new URL(pageUrl).pathname,
                            htmlFile: path.relative(OUTPUT_DIR, localPath).replace(/\\/g, '/')
                        });
                        
                    } catch (retryError) {
                        console.error(`Failed retry writing ${localPath}:`, retryError);
                        await page.close();
                        return [];
                    }
                } else {
                    await page.close();
                    return [];
                }
            }
            
            // Extract additional links from the page
            const links = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a[href]'))
                    .map(a => a.href)
                    .filter(href => href && !href.startsWith('javascript:') && !href.startsWith('mailto:'));
            });
            
            // Extract additional resources
            const additionalResources = await page.evaluate(() => {
                // Get all scripts
                const scripts = Array.from(document.querySelectorAll('script[src]'))
                    .map(script => script.src);
                
                // Get all stylesheets
                const stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
                    .map(link => link.href);
                
                // Get all images
                const images = Array.from(document.querySelectorAll('img[src]'))
                    .map(img => img.src);
                
                // Get all favicons
                const favicons = Array.from(document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]'))
                    .map(link => link.href);
                
                // Get all other resources (fonts, etc.)
                const others = Array.from(document.querySelectorAll('link[href]:not([rel="stylesheet"]):not([rel="icon"]):not([rel="shortcut icon"])'))
                    .map(link => link.href);
                
                return [...scripts, ...stylesheets, ...images, ...favicons, ...others];
            });
            
            // Process resources sequentially to avoid race conditions
            for (const resourceUrl of [...resources, ...additionalResources]) {
                await downloadResource(resourceUrl, pageUrl);
            }
            
            // Close the page
            await page.close();
            
            // Update stats
            collectedData.stats.processedPages++;
            
            // Return found links
            return links.filter(link => isAllowedUrl(link));
        } catch (error) {
            console.error(`Error processing ${pageUrl}:`, error);
            return [];
        }
    }

    // Function to process all HTML files after scraping
    async function processAllHtmlFiles() {
        console.log("\nFinal pass: Processing all HTML files to ensure consistent URLs...");
        
        // Get all HTML files recursively
        const getAllFiles = function(dirPath, arrayOfFiles) {
            files = fs.readdirSync(dirPath);
            
            arrayOfFiles = arrayOfFiles || [];
            
            files.forEach(function(file) {
                if (fs.statSync(dirPath + "/" + file).isDirectory()) {
                    arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
                } else {
                    arrayOfFiles.push(path.join(dirPath, file));
                }
            });
            
            return arrayOfFiles;
        };
        
        const allFiles = getAllFiles(OUTPUT_DIR);
        const htmlFiles = allFiles.filter(file => file.endsWith('.html'));
        
        console.log(`Found ${htmlFiles.length} HTML files to process`);
        
        // Process each HTML file with our updated URL handler
        for (const htmlFile of htmlFiles) {
            try {
                // Read file
                let content = fs.readFileSync(htmlFile, 'utf8');
                
                // Update URLs using our now-comprehensive updateHtmlUrls function
                const updatedContent = updateHtmlUrls(content);
                
                // Write back if changed
                if (content !== updatedContent) {
                    fs.writeFileSync(htmlFile, updatedContent);
                    console.log(`Updated URLs in: ${path.relative(OUTPUT_DIR, htmlFile)}`);
                }
            } catch (error) {
                console.error(`Error processing HTML file ${htmlFile}:`, error);
            }
        }
        
        console.log("Final HTML processing complete!");
    }

    // Function to extract Next.js data using the jsonExtractor module
    async function extractNextJsData() {
        console.log("\n--- Starting Next.js data extraction phase ---\n");
        
        // Ensure the json_data directory exists
        const jsonDataDir = path.join(OUTPUT_DIR, 'json_data');
        if (!fs.existsSync(jsonDataDir)) {
            fs.mkdirSync(jsonDataDir, { recursive: true });
        }
        
        // Use the imported jsonExtractor module to process the HTML files
        await jsonExtractor.extractNextJsData(collectedData, OUTPUT_DIR, jsonDataDir);
        
        // Save the collected data summary as a JSON file
        try {
            const summaryPath = path.join(OUTPUT_DIR, 'extraction_summary.json');
            // Use the fsp alias for async file operations
            await fsp.writeFile(summaryPath, JSON.stringify(collectedData, null, 2));
            console.log(`Saved extraction summary to ${summaryPath}`);
        } catch (error) {
            console.error(`Error saving extraction summary: ${error.message}`);
        }
        
        console.log("\n--- Next.js data extraction phase complete ---\n");
    }

    // Function to process CSS files and update URLs within them
    async function processCssFiles() {
        console.log("\n--- Starting CSS processing phase ---\n");
        
        // Get all CSS files recursively
        const getAllFiles = function(dirPath, arrayOfFiles) {
            const files = fs.readdirSync(dirPath);
            
            arrayOfFiles = arrayOfFiles || [];
            
            files.forEach(function(file) {
                const filePath = path.join(dirPath, file);
                if (fs.statSync(filePath).isDirectory()) {
                    arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
                } else {
                    arrayOfFiles.push(filePath);
                }
            });
            
            return arrayOfFiles;
        };
        
        const allFiles = getAllFiles(OUTPUT_DIR);
        const cssFiles = allFiles.filter(file => file.endsWith('.css'));
        
        console.log(`Found ${cssFiles.length} CSS files to process`);
        
        let processedCount = 0;
        
        // Process each CSS file
        for (const cssFile of cssFiles) {
            try {
                // Read CSS file
                let content = fs.readFileSync(cssFile, 'utf8');
                let replacementsMade = 0;
                
                // 1. Process @import statements
                // Match both formats: @import 'file.css' and @import url('file.css')
                const importRegex = /@import\s+(?:url\(['"]?(.*?)['"]?\)|['"]([^'"]+)['"]);/g;
                
                let match;
                while ((match = importRegex.exec(content)) !== null) {
                    const importUrl = match[1] || match[2];
                    if (!importUrl) continue;
                    
                    // Resolve the URL
                    let fullImportUrl;
                    if (importUrl.startsWith('http')) {
                        fullImportUrl = importUrl;
                    } else if (importUrl.startsWith('/')) {
                        fullImportUrl = `${BASE_URL}${importUrl}`;
                    } else {
                        // Get the relative directory of the current CSS file
                        const cssDir = path.dirname(cssFile);
                        const relativeToBase = path.relative(OUTPUT_DIR, cssDir);
                        
                        // Determine base path for resolution
                        // This is simplified - in a real implementation you'd need a more robust approach
                        const basePath = relativeToBase.split(path.sep).join('/');
                        fullImportUrl = `${BASE_URL}/${basePath}/${importUrl}`;
                    }
                    
                    // Get local path for this import
                    const localImportPath = getRelativePath(fullImportUrl);
                    if (localImportPath) {
                        // Convert the relative path to be relative to the current CSS file
                        const cssRelativeDir = path.dirname(path.relative(OUTPUT_DIR, cssFile));
                        const importTarget = path.join(OUTPUT_DIR, localImportPath);
                        const relativePath = path.relative(
                            path.join(OUTPUT_DIR, cssRelativeDir),
                            importTarget
                        ).replace(/\\/g, '/'); // Use forward slashes for CSS URLs
                        
                        // Replace with local path
                        let replacement;
                        if (match[1]) { // url() pattern
                            replacement = `@import url('${relativePath}');`;
                        } else { // direct string pattern
                            replacement = `@import '${relativePath}';`;
                        }
                        
                        content = content.replace(match[0], replacement);
                        replacementsMade++;
                    }
                }
                
                // 2. Process url() references
                const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
                
                while ((match = urlRegex.exec(content)) !== null) {
                    const urlPath = match[1];
                    
                    // Skip data URLs
                    if (!urlPath || urlPath.startsWith('data:')) continue;
                    
                    // Resolve the URL
                    let fullUrl;
                    if (urlPath.startsWith('http')) {
                        fullUrl = urlPath;
                    } else if (urlPath.startsWith('/')) {
                        fullUrl = `${BASE_URL}${urlPath}`;
                    } else {
                        // Get the relative directory of the current CSS file
                        const cssDir = path.dirname(cssFile);
                        const relativeToBase = path.relative(OUTPUT_DIR, cssDir);
                        
                        // Determine base path for resolution
                        const basePath = relativeToBase.split(path.sep).join('/');
                        fullUrl = `${BASE_URL}/${basePath}/${urlPath}`;
                    }
                    
                    // Get local path for this resource
                    const localResourcePath = getRelativePath(fullUrl);
                    if (localResourcePath) {
                        // Convert the relative path to be relative to the current CSS file
                        const cssRelativeDir = path.dirname(path.relative(OUTPUT_DIR, cssFile));
                        const resourceTarget = path.join(OUTPUT_DIR, localResourcePath);
                        const relativePath = path.relative(
                            path.join(OUTPUT_DIR, cssRelativeDir),
                            resourceTarget
                        ).replace(/\\/g, '/'); // Use forward slashes for CSS URLs
                        
                        // Replace with local path
                        const replacement = `url('${relativePath}')`;
                        content = content.replace(match[0], replacement);
                        replacementsMade++;
                    }
                }
                
                // Save the file if changes were made
                if (replacementsMade > 0) {
                    fs.writeFileSync(cssFile, content);
                    console.log(`Replaced ${replacementsMade} URLs in CSS file: ${path.relative(OUTPUT_DIR, cssFile)}`);
                    processedCount++;
                }
            } catch (error) {
                console.error(`Error processing CSS file ${cssFile}:`, error);
            }
        }
        
        console.log(`\nProcessed ${processedCount} CSS files with URL replacements`);
        console.log("\n--- CSS processing phase complete ---\n");
    }

    // Function to process JavaScript files and update URL references within them
    async function processJsFiles() {
        console.log("\n--- Starting JS processing phase ---\n");
        
        // Use the same function to recursively get all files
        const getAllFiles = function(dirPath, arrayOfFiles) {
            const files = fs.readdirSync(dirPath);
            
            arrayOfFiles = arrayOfFiles || [];
            
            files.forEach(function(file) {
                const filePath = path.join(dirPath, file);
                if (fs.statSync(filePath).isDirectory()) {
                    arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
                } else {
                    arrayOfFiles.push(filePath);
                }
            });
            
            return arrayOfFiles;
        };
        
        const allFiles = getAllFiles(OUTPUT_DIR);
        const jsFiles = allFiles.filter(file => file.endsWith('.js'));
        
        console.log(`Found ${jsFiles.length} JavaScript files to process`);
        
        // Create a mapping of all resources for URL resolution
        const resourceUrlMap = new Map();
        
        // Find all downloaded resources by going through all files
        for (const file of allFiles) {
            try {
                const relativePath = path.relative(OUTPUT_DIR, file).replace(/\\/g, '/');
                
                // Skip very large files to avoid running out of memory
                const stats = fs.statSync(file);
                if (stats.size > 10 * 1024 * 1024) continue; // Skip files larger than 10MB
                
                // Generate potential URLs that might point to this resource
                let originalUrl;
                if (relativePath.startsWith('assets/')) {
                    // For assets, reconstruct the potential URL
                    const parts = relativePath.split('/');
                    if (parts.length >= 3) {
                        const domain = parts[1]; // The domain part from assets/{domain}/...
                        const resourcePath = '/' + parts.slice(2).join('/');
                        originalUrl = `https://${domain}${resourcePath}`;
                        resourceUrlMap.set(originalUrl, relativePath);
                        resourceUrlMap.set(resourcePath, relativePath); // Also map the path-only version
                    }
                } else {
                    // For main domain resources
                    originalUrl = `${BASE_URL}/${relativePath}`;
                    resourceUrlMap.set(originalUrl, relativePath);
                    resourceUrlMap.set('/' + relativePath, relativePath); // Also map the path-only version
                }
            } catch (error) {
                console.error(`Error mapping resource ${file}: ${error.message}`);
            }
        }
        
        let processedCount = 0;
        
        // Process each JS file
        for (const jsFile of jsFiles) {
            try {
                // Read JavaScript file
                let content = fs.readFileSync(jsFile, 'utf8');
                let replacementsMade = 0;
                
                // Get relative directory of this JS file (for creating correct relative paths)
                const jsRelativeDir = path.dirname(path.relative(OUTPUT_DIR, jsFile));
                
                // 1. Process dynamic import() statements
                const importRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
                let match;
                while ((match = importRegex.exec(content)) !== null) {
                    const importPath = match[1];
                    
                    // Skip if it's already a relative path starting with ./
                    if (importPath.startsWith('./') || importPath.startsWith('../')) continue;
                    
                    // Resolve the URL
                    let fullImportUrl;
                    if (importPath.startsWith('http')) {
                        fullImportUrl = importPath;
                    } else if (importPath.startsWith('/')) {
                        fullImportUrl = `${BASE_URL}${importPath}`;
                    } else {
                        // For importing a module ID or non-relative path
                        fullImportUrl = `${BASE_URL}/${importPath}`;
                        
                        // Also try with .js extension
                        if (!resourceUrlMap.has(fullImportUrl)) {
                            resourceUrlMap.set(fullImportUrl, `${importPath}.js`);
                        }
                    }
                    
                    // Check if we have a local path for this import
                    let localImportPath = resourceUrlMap.get(fullImportUrl);
                    
                    // Try with .js extension if not found
                    if (!localImportPath && !fullImportUrl.endsWith('.js')) {
                        localImportPath = resourceUrlMap.get(`${fullImportUrl}.js`);
                    }
                    
                    if (localImportPath) {
                        // Make the path relative to the current JS file
                        const importTarget = path.join(OUTPUT_DIR, localImportPath);
                        const relativePath = path.relative(
                            path.join(OUTPUT_DIR, jsRelativeDir),
                            importTarget
                        ).replace(/\\/g, '/'); // Use forward slashes for JS
                        
                        // Ensure the path starts with ./ if it's not already going up directories
                        const prefixedPath = relativePath.startsWith('../') 
                            ? relativePath 
                            : './' + relativePath;
                        
                        // Replace the import path
                        const original = `import("${importPath}")`;
                        const replacement = `import("${prefixedPath}")`;
                        content = content.replace(original, replacement);
                        replacementsMade++;
                    }
                }
                
                // 2. Process URL references in strings
                // This handles multiple patterns common in JavaScript files
                
                // 2.1 Handle Next.js specific patterns
                const nextJsPatterns = [
                    // Next.js static file references
                    /(["'])(\/_next\/static\/[^"']+)(["'])/g,
                    // Next.js chunk loading
                    /path:\s*["'](\/[^"']+)["']/g
                ];
                
                for (const pattern of nextJsPatterns) {
                    while ((match = pattern.exec(content)) !== null) {
                        let urlPath, prefix = '', suffix = '';
                        
                        // Handle different regex patterns and capture groups
                        if (match[2]) { 
                            // For the first regex with capture groups
                            urlPath = match[2];
                            prefix = match[1];
                            suffix = match[3];
                        } else {
                            // For the path: "..." pattern
                            urlPath = match[1];
                            isPathPattern = true;
                        }
                        
                        // Skip if not a path we should process
                        if (!urlPath) continue;
                        
                        // Build the full URL
                        const fullUrl = urlPath.startsWith('http') 
                            ? urlPath 
                            : `${BASE_URL}${urlPath}`;
                        
                        // Find local path
                        const localPath = resourceUrlMap.get(urlPath) || resourceUrlMap.get(fullUrl);
                        
                        if (localPath) {
                            // Make the path relative to the current JS file
                            const resourceTarget = path.join(OUTPUT_DIR, localPath);
                            const relativePath = path.relative(
                                path.join(OUTPUT_DIR, jsRelativeDir),
                                resourceTarget
                            ).replace(/\\/g, '/'); // Use forward slashes for JS
                            
                            // Replace using the appropriate pattern
                            if (match[2]) {
                                // For quoted strings
                                const replacement = `${prefix}${relativePath}${suffix}`;
                                content = content.replace(match[0], replacement);
                            } else {
                                // For path: "..." pattern
                                const replacement = `path:"${relativePath}"`;
                                content = content.replace(match[0], replacement);
                            }
                            
                            replacementsMade++;
                        }
                    }
                }
                
                // 2.2 Handle full domain URLs
                const domainRegex = new RegExp(`(["'])(${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']+)(["'])`, 'g');
                while ((match = domainRegex.exec(content)) !== null) {
                    const fullUrl = match[2];
                    
                    // Skip if not a valid URL
                    if (!fullUrl) continue;
                    
                    // Find local path
                    const localPath = resourceUrlMap.get(fullUrl);
                    
                    if (localPath) {
                        // Make the path relative to the current JS file
                        const resourceTarget = path.join(OUTPUT_DIR, localPath);
                        const relativePath = path.relative(
                            path.join(OUTPUT_DIR, jsRelativeDir),
                            resourceTarget
                        ).replace(/\\/g, '/'); // Use forward slashes for JS
                        
                        // Replace the URL with relative path
                        const replacement = `${match[1]}${relativePath}${match[3]}`;
                        content = content.replace(match[0], replacement);
                        replacementsMade++;
                    }
                }
                
                // Save the file if changes were made
                if (replacementsMade > 0) {
                    fs.writeFileSync(jsFile, content);
                    console.log(`Replaced ${replacementsMade} URLs in JS file: ${path.relative(OUTPUT_DIR, jsFile)}`);
                    processedCount++;
                }
            } catch (error) {
                console.error(`Error processing JS file ${jsFile}:`, error);
            }
        }
        
        console.log(`\nProcessed ${processedCount} JavaScript files with URL replacements`);
        console.log("\n--- JS processing phase complete ---\n");
    }

    // Function to process HTML files and update all resource references
    async function processHtmlFiles() {
        console.log("\n--- Starting HTML processing phase ---\n");
        
        // Get all files recursively using the same utility function as other processors
        const getAllFiles = function(dirPath, arrayOfFiles) {
            const files = fs.readdirSync(dirPath);
            
            arrayOfFiles = arrayOfFiles || [];
            
            files.forEach(function(file) {
                const filePath = path.join(dirPath, file);
                if (fs.statSync(filePath).isDirectory()) {
                    arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
                } else {
                    arrayOfFiles.push(filePath);
                }
            });
            
            return arrayOfFiles;
        };
        
        const allFiles = getAllFiles(OUTPUT_DIR);
        const htmlFiles = allFiles.filter(file => file.endsWith('.html'));
        
        console.log(`Found ${htmlFiles.length} HTML files to process`);
        console.log(`First HTML file: ${htmlFiles.length > 0 ? htmlFiles[0] : 'none'}`);
        
        // Create a mapping of all resources for URL resolution, similar to JS processing
        const resourceUrlMap = new Map();
        
        // Find all downloaded resources by going through all files
        for (const file of allFiles) {
            try {
                const relativePath = path.relative(OUTPUT_DIR, file).replace(/\\/g, '/');
                
                // Skip very large files to avoid running out of memory
                const stats = fs.statSync(file);
                if (stats.size > 10 * 1024 * 1024) continue; // Skip files larger than 10MB
                
                // Generate potential URLs that might point to this resource
                let originalUrl;
                if (relativePath.startsWith('assets/')) {
                    // For assets, reconstruct the potential URL
                    const parts = relativePath.split('/');
                    if (parts.length >= 3) {
                        const domain = parts[1]; // The domain part from assets/{domain}/...
                        const resourcePath = '/' + parts.slice(2).join('/');
                        originalUrl = `https://${domain}${resourcePath}`;
                        resourceUrlMap.set(originalUrl, relativePath);
                        resourceUrlMap.set(resourcePath, relativePath); // Also map the path-only version
                    }
                } else {
                    // For main domain resources
                    originalUrl = `${BASE_URL}/${relativePath}`;
                    resourceUrlMap.set(originalUrl, relativePath);
                    resourceUrlMap.set('/' + relativePath, relativePath); // Also map the path-only version
                }
            } catch (error) {
                console.error(`Error mapping resource ${file}: ${error.message}`);
            }
        }
        
        console.log(`Built a resource map with ${resourceUrlMap.size} entries`);
        
        // Debug: Log some sample entries from the resource map
        console.log("Sample resource map entries:");
        let count = 0;
        for (const [url, path] of resourceUrlMap.entries()) {
            console.log(`  ${url} => ${path}`);
            count++;
            if (count >= 5) break; // Limit to 5 entries for brevity
        }
        
        // Helper function to categorize resource types
        function categorizeResource(url) {
            if (!url) return 'other';
            
            const lowerUrl = url.toLowerCase();
            
            if (lowerUrl.includes('.css') || lowerUrl.includes('text/css')) return 'css';
            if (lowerUrl.includes('.js') || lowerUrl.includes('javascript')) return 'js';
            if (/\.(png|jpg|jpeg|gif|svg|webp|ico|avif)/.test(lowerUrl)) return 'image';
            if (/\.(woff|woff2|ttf|otf|eot)/.test(lowerUrl)) return 'font';
            
            return 'other';
        }
        
        let processedCount = 0;
        
        // Process each HTML file
        for (const htmlFile of htmlFiles) {
            try {
                console.log(`\nProcessing HTML file: ${htmlFile}`);
                
                // Read the HTML file
                let htmlContent = fs.readFileSync(htmlFile, 'utf8');
                
                // Debug: Get a sample of the HTML content
                const contentPreview = htmlContent.substring(0, 200).replace(/\n/g, ' ') + '...';
                console.log(`HTML content preview: ${contentPreview}`);
                
                // Debug: Check if HTML contains any external URLs
                const urlMatches = htmlContent.match(/https?:\/\/[^"'\s)]+/g) || [];
                console.log(`Found ${urlMatches.length} external URLs in HTML`);
                if (urlMatches.length > 0) {
                    console.log(`Sample URLs found:`);
                    urlMatches.slice(0, 3).forEach(url => console.log(`  ${url}`));
                }
                
                // Debug: Check if HTML contains any relative URLs
                const relativeMatches = htmlContent.match(/(?:href|src|content)=["']\/[^"']+["']/g) || [];
                console.log(`Found ${relativeMatches.length} relative URLs in HTML`);
                if (relativeMatches.length > 0) {
                    console.log(`Sample relative URLs found:`);
                    relativeMatches.slice(0, 3).forEach(url => console.log(`  ${url}`));
                }
                
                // Debug: Check for JSON objects with URLs
                // Look for potential JSON content in script tags or embedded directly
                const jsonScriptMatches = htmlContent.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
                console.log(`Found ${jsonScriptMatches.length} script tags in HTML`);
                
                let replacementCounts = {
                    css: 0,
                    js: 0,
                    images: 0,
                    fonts: 0,
                    other: 0,
                    jsonUrls: 0,  // Counter for JSON URL replacements
                    jsxUrls: 0    // Counter for JSX component URL replacements
                };
                
                // Get the relative directory of this HTML file (for creating correct relative paths)
                const htmlRelativeDir = path.dirname(path.relative(OUTPUT_DIR, htmlFile));
                console.log(`HTML relative directory: ${htmlRelativeDir}`);
                
                // First, process JSX components patterns (_jsx, _jsxs)
                // These are common in Next.js serialized React components
                
                // Define patterns for JSX components with URLs
                const jsxPatterns = [
                    // Basic _jsx pattern with src attribute (common for images)
                    /_jsx\(\s*[\w._]+\s*,\s*\{\s*src\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
                    
                    // JSX with img tag and src attribute
                    /_jsx\(\s*[\w._]+\.img\s*,\s*\{\s*src\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
                    
                    // JSX with escaped double quotes (common in serialized JSX)
                    /_jsx\(\s*[\w._]+\s*,\s*\{\s*src\s*:\s*\\["'](https?:\/\/[^\\'"]+)\\["']/gi,
                    
                    // JSX with children that is an image
                    /children\s*:\s*_jsx\(\s*[\w._]+\s*,\s*\{\s*src\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
                    
                    // Complex/nested JSX components with src attribute
                    /src\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
                    
                    // Escaped versions
                    /src\\?:\s*\\?["'](https?:\/\/[^\\'"]+)\\?["']/gi
                ];
                
                for (const pattern of jsxPatterns) {
                    // Keep a copy of the original content for this pattern to avoid regex state issues
                    const originalContent = htmlContent;
                    let jsxMatches;
                    let jsxReplacements = 0;
                    
                    while ((jsxMatches = pattern.exec(originalContent)) !== null) {
                        const fullMatch = jsxMatches[0];
                        const urlMatch = jsxMatches[1]; // The captured URL
                        
                        if (!urlMatch || !urlMatch.startsWith('http')) continue;
                        
                        console.log(`Found JSX URL: ${urlMatch}`);
                        
                        // Find the local path for this URL
                        const localPath = resourceUrlMap.get(urlMatch);
                        
                        if (localPath) {
                            // Make the path relative to the HTML file
                            const resourceTarget = path.join(OUTPUT_DIR, localPath);
                            const relativePath = path.relative(
                                path.join(OUTPUT_DIR, htmlRelativeDir),
                                resourceTarget
                            ).replace(/\\/g, '/'); // Use forward slashes
                            
                            console.log(`  JSX URL replacement: ${urlMatch} -> ${relativePath}`);
                            
                            // Create a replacement that preserves the JSX structure
                            // Detect if we're dealing with escaped quotes or normal quotes
                            const hasEscapedQuotes = fullMatch.includes('\\"') || fullMatch.includes("\\'");
                            
                            // Handle different quoting styles in the replacement
                            let replacement;
                            if (hasEscapedQuotes) {
                                // For escaped quotes, preserve the escaping
                                if (fullMatch.includes('\\"')) {
                                    replacement = fullMatch.replace(urlMatch, relativePath);
                                } else {
                                    replacement = fullMatch.replace(urlMatch, relativePath);
                                }
                            } else {
                                // For regular quotes
                                replacement = fullMatch.replace(urlMatch, relativePath);
                            }
                            
                            // Replace the matched text with our modified version
                            htmlContent = htmlContent.replace(fullMatch, replacement);
                            
                            jsxReplacements++;
                        }
                    }
                    
                    if (jsxReplacements > 0) {
                        replacementCounts.jsxUrls += jsxReplacements;
                        console.log(`Made ${jsxReplacements} JSX URL replacements for pattern ${pattern}`);
                    }
                }
                
                // Process JSON objects (previously implemented)
                const jsonUrlPatterns = [
                    // Common JSON patterns with URLs as values
                    /"(?:src|url|href|background|image|logo|avatar|icon|thumbnail|banner|media|dark|light)":\s*"(https?:\/\/[^"]+)"/gi,
                    // URLs in arrays
                    /\[\s*"(https?:\/\/[^"]+)"\s*\]/gi,
                    // Generic URL detection in JSON strings
                    /"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|svg|webp|mp4|mp3|pdf|css|js))"/gi
                ];
                
                for (const pattern of jsonUrlPatterns) {
                    const originalContent = htmlContent;
                    let jsonMatches;
                    let jsonReplacements = 0;
                    
                    while ((jsonMatches = pattern.exec(originalContent)) !== null) {
                        const fullMatch = jsonMatches[0];
                        const urlMatch = jsonMatches[1];
                        
                        if (!urlMatch || !urlMatch.startsWith('http')) continue;
                        
                        console.log(`Found JSON URL: ${urlMatch}`);
                        
                        // Find the local path for this URL
                        const localPath = resourceUrlMap.get(urlMatch);
                        
                        if (localPath) {
                            // Make the path relative to the HTML file
                            const resourceTarget = path.join(OUTPUT_DIR, localPath);
                            const relativePath = path.relative(
                                path.join(OUTPUT_DIR, htmlRelativeDir),
                                resourceTarget
                            ).replace(/\\/g, '/'); // Use forward slashes
                            
                            console.log(`  JSON URL replacement: ${urlMatch} -> ${relativePath}`);
                            
                            // Create a replacement that preserves the JSON structure
                            const replacement = fullMatch.replace(urlMatch, relativePath);
                            htmlContent = htmlContent.replace(fullMatch, replacement);
                            
                            jsonReplacements++;
                        }
                    }
                    
                    if (jsonReplacements > 0) {
                        replacementCounts.jsonUrls += jsonReplacements;
                        console.log(`Made ${jsonReplacements} JSON URL replacements`);
                    }
                }
                
                // Process regular URL patterns in HTML attributes (unchanged from before)
                for (const [remoteUrl, localPath] of resourceUrlMap.entries()) {
                    // Skip URLs that are not full URLs (to avoid duplicates)
                    if (!remoteUrl.startsWith('http') && !remoteUrl.startsWith('/')) continue;
                    
                    // Debug: Check if the current remoteUrl appears in the HTML content
                    const urlInHtml = htmlContent.includes(remoteUrl);
                    
                    // Debug: For debugging, log only if the URL is found in the HTML
                    if (urlInHtml) {
                        console.log(`Found match: ${remoteUrl} in HTML`);
                    }
                    
                    // Determine resource type
                    const isCSS = remoteUrl.toLowerCase().includes('.css') || categorizeResource(remoteUrl) === 'css';
                    const isJS = remoteUrl.toLowerCase().includes('.js') || categorizeResource(remoteUrl) === 'js';
                    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif'].some(ext => 
                        remoteUrl.toLowerCase().includes('.' + ext)) || categorizeResource(remoteUrl) === 'image';
                    const isFont = ['woff', 'woff2', 'ttf', 'otf', 'eot'].some(ext => 
                        remoteUrl.toLowerCase().includes('.' + ext)) || categorizeResource(remoteUrl) === 'font';
                    
                    // Get the resource type for tracking replacements
                    let resourceType = 'other';
                    if (isCSS) resourceType = 'css';
                    else if (isJS) resourceType = 'js';
                    else if (isImage) resourceType = 'images';
                    else if (isFont) resourceType = 'fonts';
                    
                    // Local path should use forward slashes for URLs in HTML
                    const localUrl = localPath.replace(/\\/g, '/');
                    
                    // Make the path relative to the current HTML file
                    const resourceTarget = path.join(OUTPUT_DIR, localPath);
                    const relativePath = path.relative(
                        path.join(OUTPUT_DIR, htmlRelativeDir),
                        resourceTarget
                    ).replace(/\\/g, '/'); // Use forward slashes for HTML URLs
                    
                    // Debug: Log the path calculation for hits
                    if (urlInHtml) {
                        console.log(`  Remote URL: ${remoteUrl}`);
                        console.log(`  Local path: ${localPath}`);
                        console.log(`  Relative path: ${relativePath}`);
                    }
                    
                    // Create regex patterns that cover the common ways URLs appear in HTML
                    const regexPatterns = [];
                    
                    if (remoteUrl.startsWith('http')) {
                        // For absolute URLs
                        regexPatterns.push(
                            // href attribute
                            new RegExp(`href=["']${escapeRegExp(remoteUrl)}["']`, 'gi'),
                            // src attribute
                            new RegExp(`src=["']${escapeRegExp(remoteUrl)}["']`, 'gi'),
                            // background or content
                            new RegExp(`(background|content)=["']${escapeRegExp(remoteUrl)}["']`, 'gi'),
                            // url() in style
                            new RegExp(`url\\(["']?${escapeRegExp(remoteUrl)}["']?\\)`, 'gi')
                        );
                    }
                    
                    // Also try with the URL path (without domain)
                    if (remoteUrl.startsWith('/')) {
                        regexPatterns.push(
                            // href attribute
                            new RegExp(`href=["']${escapeRegExp(remoteUrl)}["']`, 'gi'),
                            // src attribute
                            new RegExp(`src=["']${escapeRegExp(remoteUrl)}["']`, 'gi'),
                            // background or content
                            new RegExp(`(background|content)=["']${escapeRegExp(remoteUrl)}["']`, 'gi'),
                            // url() in style
                            new RegExp(`url\\(["']?${escapeRegExp(remoteUrl)}["']?\\)`, 'gi')
                        );
                    }
                    
                    // Try to match and replace using the patterns
                    let patternMatches = 0;
                    
                    for (const pattern of regexPatterns) {
                        // Debug: Check if this pattern matches anything in the content
                        const matches = htmlContent.match(pattern);
                        if (matches && matches.length > 0) {
                            console.log(`  Pattern ${pattern} matched ${matches.length} times`);
                            console.log(`  Example match: ${matches[0]}`);
                            
                            // Perform the replacement
                            const originalContent = htmlContent;
                            
                            // Replace with the relative path
                            htmlContent = htmlContent.replace(pattern, (match) => {
                                // Determine what attribute type this is
                                if (match.includes('href=')) {
                                    return `href="${relativePath}"`;
                                } else if (match.includes('src=')) {
                                    return `src="${relativePath}"`;
                                } else if (match.includes('background=')) {
                                    return `background="${relativePath}"`;
                                } else if (match.includes('content=')) {
                                    return `content="${relativePath}"`;
                                } else if (match.includes('url(')) {
                                    return `url('${relativePath}')`;
                                }
                                return match.replace(remoteUrl, relativePath);
                            });
                            
                            // Check if the replacement actually changed anything
                            if (originalContent !== htmlContent) {
                                patternMatches += matches.length;
                                console.log(`  Successfully replaced ${matches.length} occurrences`);
                            } else {
                                console.log(`  WARNING: Replacement didn't change content!`);
                            }
                        }
                    }
                    
                    // If we made any replacements, update the count
                    if (patternMatches > 0) {
                        replacementCounts[resourceType] += patternMatches;
                    }
                }
                
                // Total replacements
                const totalReplacements = Object.values(replacementCounts).reduce((sum, count) => sum + count, 0);
                console.log(`Total replacements for this HTML file: ${totalReplacements}`);
                console.log(`  - CSS: ${replacementCounts.css}`);
                console.log(`  - JS: ${replacementCounts.js}`);
                console.log(`  - Images: ${replacementCounts.images}`);
                console.log(`  - Fonts: ${replacementCounts.fonts}`);
                console.log(`  - Other: ${replacementCounts.other}`);
                console.log(`  - JSON URLs: ${replacementCounts.jsonUrls}`);
                console.log(`  - JSX Component URLs: ${replacementCounts.jsxUrls}`);
                
                // Save the file if changes were made
                if (totalReplacements > 0) {
                    fs.writeFileSync(htmlFile, htmlContent);
                    console.log(`Saved HTML file with ${totalReplacements} URLs replaced: ${path.relative(OUTPUT_DIR, htmlFile)}`);
                    processedCount++;
                } else {
                    console.log(`No changes made to HTML file: ${path.relative(OUTPUT_DIR, htmlFile)}`);
                }
            } catch (error) {
                console.error(`Error processing HTML file ${htmlFile}: ${error.message}`);
            }
        }
        
        console.log(`\nProcessed ${processedCount} HTML files with URL replacements`);
        console.log("\n--- HTML processing phase complete ---\n");
    }

    // Helper function to escape special characters in regex
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
    }

    // Function to process JavaScript files for edge cases and special patterns
    async function processJsFilesEdgeCases() {
        console.log("\n--- Starting JS edge case processing phase ---\n");
        
        // Get all files recursively using the same utility function as other processors
        const getAllFiles = function(dirPath, arrayOfFiles) {
            const files = fs.readdirSync(dirPath);
            
            arrayOfFiles = arrayOfFiles || [];
            
            files.forEach(function(file) {
                const filePath = path.join(dirPath, file);
                if (fs.statSync(filePath).isDirectory()) {
                    arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
                } else {
                    arrayOfFiles.push(filePath);
                }
            });
            
            return arrayOfFiles;
        };
        
        const allFiles = getAllFiles(OUTPUT_DIR);
        const jsFiles = allFiles.filter(file => file.endsWith('.js'));
        
        console.log(`Found ${jsFiles.length} JavaScript files to process for edge cases`);
        
        // Create a mapping of all resources for URL resolution
        const resourceUrlMap = new Map();
        
        // Find all downloaded resources by going through all files
        for (const file of allFiles) {
            try {
                const relativePath = path.relative(OUTPUT_DIR, file).replace(/\\/g, '/');
                
                // Skip very large files to avoid running out of memory
                const stats = fs.statSync(file);
                if (stats.size > 10 * 1024 * 1024) continue; // Skip files larger than 10MB
                
                // Generate potential URLs that might point to this resource
                let originalUrl;
                if (relativePath.startsWith('assets/')) {
                    // For assets, reconstruct the potential URL
                    const parts = relativePath.split('/');
                    if (parts.length >= 3) {
                        const domain = parts[1]; // The domain part from assets/{domain}/...
                        const resourcePath = '/' + parts.slice(2).join('/');
                        originalUrl = `https://${domain}${resourcePath}`;
                        resourceUrlMap.set(originalUrl, relativePath);
                        resourceUrlMap.set(resourcePath, relativePath); // Also map the path-only version
                    }
                } else {
                    // For main domain resources
                    originalUrl = `${BASE_URL}/${relativePath}`;
                    resourceUrlMap.set(originalUrl, relativePath);
                    resourceUrlMap.set('/' + relativePath, relativePath); // Also map the path-only version
                }
            } catch (error) {
                console.error(`Error mapping resource ${file}: ${error.message}`);
            }
        }
        
        let processedCount = 0;
        
        // Process each JS file
        for (const jsFile of jsFiles) {
            try {
                // Read JavaScript file
                let content = fs.readFileSync(jsFile, 'utf8');
                let replacementsMade = 0;
                
                // Get relative directory of this JS file (for creating correct relative paths)
                const jsRelativeDir = path.dirname(path.relative(OUTPUT_DIR, jsFile));
                
                // 1. Handle complex JSX component patterns
                // These patterns are specific to the JSX serialization format used in Next.js and similar frameworks
                
                // Handle various complex JSX patterns with URLs
                const jsxPatterns = [
                    // JSX pattern for images in React component trees (_jsx syntax)
                    {
                        pattern: /src\s*:\s*\\?"(https?:\/\/[^"\\]+)\\?"/gi,
                        process: (match, url) => {
                            // Find the local path for this URL
                            const localPath = resourceUrlMap.get(url);
                            if (localPath) {
                                // Make the path relative to the current JS file
                                const resourceTarget = path.join(OUTPUT_DIR, localPath);
                                const relativePath = path.relative(
                                    path.join(OUTPUT_DIR, jsRelativeDir),
                                    resourceTarget
                                ).replace(/\\/g, '/'); // Use forward slashes for JS
                                
                                console.log(`  JSX URL replacement in JS file: ${url} -> ${relativePath}`);
                                
                                // For escaped quotes
                                if (match.includes('\\"')) {
                                    return match.replace(url, relativePath);
                                } else {
                                    return match.replace(url, relativePath);
                                }
                            }
                            return match;
                        }
                    },
                    
                    // Handle _jsx with children pattern for images
                    {
                        pattern: /children\s*:\s*_jsx\(\s*[\w._]+\s*,\s*\{\s*src\s*:\s*\\?"(https?:\/\/[^"\\]+)\\?"/gi,
                        process: (match, url) => {
                            // Find the local path for this URL
                            const localPath = resourceUrlMap.get(url);
                            if (localPath) {
                                // Make the path relative to the current JS file
                                const resourceTarget = path.join(OUTPUT_DIR, localPath);
                                const relativePath = path.relative(
                                    path.join(OUTPUT_DIR, jsRelativeDir),
                                    resourceTarget
                                ).replace(/\\/g, '/'); // Use forward slashes for JS
                                
                                console.log(`  JSX nested URL replacement in JS file: ${url} -> ${relativePath}`);
                                
                                return match.replace(url, relativePath);
                            }
                            return match;
                        }
                    },
                    
                    // Specific Mintlify patterns (referencing the static image files)
                    {
                        pattern: /(https:\/\/mintlify\.s3\.us-west-1\.amazonaws\.com\/[^"\\]+)/gi,
                        process: (match, url) => {
                            // Find the local path for this URL
                            const localPath = resourceUrlMap.get(url);
                            if (localPath) {
                                // Make the path relative to the current JS file
                                const resourceTarget = path.join(OUTPUT_DIR, localPath);
                                const relativePath = path.relative(
                                    path.join(OUTPUT_DIR, jsRelativeDir),
                                    resourceTarget
                                ).replace(/\\/g, '/'); // Use forward slashes for JS
                                
                                console.log(`  Mintlify URL replacement: ${url} -> ${relativePath}`);
                                
                                return relativePath;
                            }
                            return match;
                        }
                    },
                    
                    // Pattern for URLs inside template literals
                    {
                        pattern: /\${(https?:\/\/[^}]+)}/gi,
                        process: (match, url) => {
                            // Find the local path for this URL
                            const localPath = resourceUrlMap.get(url);
                            if (localPath) {
                                // Make the path relative to the current JS file
                                const resourceTarget = path.join(OUTPUT_DIR, localPath);
                                const relativePath = path.relative(
                                    path.join(OUTPUT_DIR, jsRelativeDir),
                                    resourceTarget
                                ).replace(/\\/g, '/'); // Use forward slashes for JS
                                
                                console.log(`  Template literal URL replacement: ${url} -> ${relativePath}`);
                                
                                return '${' + relativePath + '}';
                            }
                            return match;
                        }
                    }
                ];
                
                // Apply the JSX patterns
                for (const { pattern, process } of jsxPatterns) {
                    const originalContent = content;
                    let match;
                    
                    // Reset the pattern's lastIndex to start from the beginning
                    pattern.lastIndex = 0;
                    
                    let matchCount = 0;
                    while ((match = pattern.exec(originalContent)) !== null) {
                        // Skip if the URL is not valid
                        if (!match[1] || !match[1].startsWith('http')) continue;
                        
                        const fullMatch = match[0];
                        const url = match[1];
                        
                        // Process the match
                        const replacement = process(fullMatch, url);
                        
                        // If a replacement was made, update the content
                        if (replacement !== fullMatch) {
                            content = content.replace(fullMatch, replacement);
                            matchCount++;
                        }
                    }
                    
                    if (matchCount > 0) {
                        replacementsMade += matchCount;
                        console.log(`Made ${matchCount} replacements with pattern ${pattern}`);
                    }
                }
                
                // 2. Special edge case replacements
                // These are common patterns in JavaScript files that need special handling
                
                const edgeCaseReplacements = [
                    // Replace problematic code patterns
                    {
                        pattern: /"pdf"===d/g,
                        replacement: '"pdf"==="pdf"'
                    },
                    // Replace Mintlify CDN URLs with local paths
                    {
                        pattern: /https:\/\/mintlify\.b-cdn\.net\/v6\.6\.0\/lucide\/\$\{t\}\.svg/g,
                        replacement: "/assets/mintlify.b-cdn.net/v6.6.0/lucide/${t}.svg"
                    },
                    {
                        pattern: /https:\/\/mintlify\.b-cdn\.net\/v6\.6\.0\/\$\{r\?\?\"regular\"\}\/\$\{t\}/g,
                        replacement: "/assets/mintlify.b-cdn.net/v6.6.0/${r??\"regular\"}/${t}"
                    },
                    {
                        pattern: /https:\/\/mintlify\.b-cdn\.net\/v6\.6\.0\/brands\/\$\{t\}\.svg/g,
                        replacement: "/assets/mintlify.b-cdn.net/v6.6.0/brands/${t}.svg"
                    },
                    // Visual improvements for certain elements
                    {
                        pattern: /backgroundColor:"transparent"/g,
                        replacement: 'backgroundColor:"white",borderRadius:3,padding:"1px"'
                    }
                ];
                
                // Apply the edge case replacements
                for (const { pattern, replacement } of edgeCaseReplacements) {
                    const originalContent = content;
                    content = content.replace(pattern, replacement);
                    
                    // Count the number of replacements
                    const matchCount = (originalContent.match(pattern) || []).length;
                    if (matchCount > 0) {
                        replacementsMade += matchCount;
                        console.log(`Made ${matchCount} replacements with edge case pattern ${pattern}`);
                    }
                }
                
                // Save the file if changes were made
                if (replacementsMade > 0) {
                    fs.writeFileSync(jsFile, content);
                    console.log(`Replaced ${replacementsMade} patterns in JS file: ${path.relative(OUTPUT_DIR, jsFile)}`);
                    processedCount++;
                }
            } catch (error) {
                console.error(`Error processing JS file ${jsFile} for edge cases:`, error);
            }
        }
        
        console.log(`\nProcessed ${processedCount} JavaScript files for edge cases`);
        console.log("\n--- JS edge case processing phase complete ---\n");
    }

    // Function to download masked SVG resources
    async function downloadMaskedSvgResources() {
        console.log("\n--- Starting masked SVG resources download ---\n");

        // Get all HTML and CSS files to scan for mask references
        const getAllFiles = function(dirPath, arrayOfFiles) {
            const files = fs.readdirSync(dirPath);
            
            arrayOfFiles = arrayOfFiles || [];
            
            files.forEach(function(file) {
                const filePath = path.join(dirPath, file);
                if (fs.statSync(filePath).isDirectory()) {
                    arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
                } else {
                    arrayOfFiles.push(filePath);
                }
            });
            
            return arrayOfFiles;
        };
        
        const allFiles = getAllFiles(OUTPUT_DIR);
        const cssAndHtmlFiles = allFiles.filter(file => file.endsWith('.css') || file.endsWith('.html') || file.endsWith('.js'));
        
        // Set to keep track of found masked URLs
        const maskedUrls = new Set();
        
        // RegExp to find mask image URLs in CSS
        const maskRegexes = [
            /-webkit-mask-image\s*:\s*url\(['"]?(https?:\/\/[^'"()]+)['"]?\)/gi,
            /mask-image\s*:\s*url\(['"]?(https?:\/\/[^'"()]+)['"]?\)/gi,
            /-webkit-mask-image\s*:\s*url\(['"]?([^'"()]+)['"]?\)/gi,
            /mask-image\s*:\s*url\(['"]?([^'"()]+)['"]?\)/gi
        ];
        
        // Scan all files for mask-image and -webkit-mask-image URLs
        console.log("Scanning files for masked SVG references...");
        for (const file of cssAndHtmlFiles) {
            try {
                const content = fs.readFileSync(file, 'utf8');
                
                for (const regex of maskRegexes) {
                    let match;
                    while ((match = regex.exec(content)) !== null) {
                        const maskUrl = match[1];
                        
                        // Check if it's a URL we should process
                        if (maskUrl && !maskUrl.startsWith('data:')) {
                            let fullUrl = maskUrl;
                            
                            // Convert relative URLs to absolute URLs
                            if (maskUrl.startsWith('/')) {
                                fullUrl = `${BASE_URL}${maskUrl.replace(/^\/assets\//, '/')}`;
                            } else if (!maskUrl.startsWith('http')) {
                                continue; // Skip if not absolute or root-relative URL
                            }
                            
                            // Add to our list of URLs to download
                            maskedUrls.add(fullUrl);
                        }
                    }
                }
            } catch (error) {
                console.error(`Error scanning file ${file} for mask URLs:`, error);
            }
        }
        
        console.log(`Found ${maskedUrls.size} masked SVG URLs to download`);
        
        // Download each masked resource
        let downloadedCount = 0;
        for (const url of maskedUrls) {
            if (url.includes('/duotone/') || url.includes('/regular/') || url.includes('/solid/') || url.includes('/brands/')) {
                try {
                    // Check if the URL is allowed
                    if (!isAllowedUrl(url)) {
                        console.log(`Skipping masked URL from disallowed domain: ${url}`);
                        continue;
                    }
                    
                    // Get the relative path for this resource
                    const relativePath = getRelativePath(url);
                    if (!relativePath) {
                        console.log(`Unable to determine relative path for: ${url}`);
                        continue;
                    }
                    
                    // Create the local file path
                    const localPath = path.join(OUTPUT_DIR, relativePath);
                    
                    // Check if file already exists (might have been downloaded earlier)
                    if (fs.existsSync(localPath)) {
                        console.log(`Masked SVG already exists: ${relativePath}`);
                        continue;
                    }
                    
                    // Create directory if it doesn't exist
                    const dir = path.dirname(localPath);
                    try {
                        fs.mkdirSync(dir, { recursive: true });
                    } catch (dirError) {
                        console.error(`Error creating directory ${dir}:`, dirError);
                        continue;
                    }
                    
                    // Download the resource
                    console.log(`Downloading masked SVG: ${url} -> ${localPath}`);
                    
                    try {
                        const response = await fetch(url);
                        
                        if (!response.ok) {
                            console.error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
                            continue;
                        }
                        
                        // Write the file
                        const buffer = await response.arrayBuffer();
                        fs.writeFileSync(localPath, Buffer.from(buffer));
                        downloadedCount++;
                    } catch (fetchError) {
                        console.error(`Failed to fetch ${url}:`, fetchError.message);
                        continue;
                    }
                } catch (error) {
                    console.error(`Error downloading masked SVG ${url}:`, error);
                }
            }
        }
        
        console.log(`\nDownloaded ${downloadedCount} masked SVG files`);
        console.log("\n--- Masked SVG download complete ---\n");
        
        // Now update all mask-image references in files
        console.log("\n--- Starting mask-image URL replacements ---\n");
        
        let updatedFileCount = 0;
        
        for (const file of cssAndHtmlFiles) {
            try {
                let content = fs.readFileSync(file, 'utf8');
                let replacementsMade = 0;
                const originalContent = content;
                
                // Get the relative directory of the file
                const fileRelativeDir = path.dirname(path.relative(OUTPUT_DIR, file));
                
                // Process mask-image URLs
                content = content.replace(
                    /(-webkit-mask-image\s*:\s*url\(['"]?)(https?:\/\/[^'"()]+)(['"]?\))/gi,
                    (match, prefix, url, suffix) => {
                        if (!isAllowedUrl(url)) return match;
                        
                        const relativePath = getRelativePath(url);
                        if (!relativePath) return match;
                        
                        // Make the path relative to the file
                        const resourceTarget = path.join(OUTPUT_DIR, relativePath);
                        const finalPath = path.relative(
                            path.join(OUTPUT_DIR, fileRelativeDir),
                            resourceTarget
                        ).replace(/\\/g, '/'); // Use forward slashes
                        
                        replacementsMade++;
                        return `${prefix}/assets/${url.split('//')[1]}${suffix}`;
                    }
                );
                
                // Process mask-image URLs with just the path
                content = content.replace(
                    /(-webkit-mask-image\s*:\s*url\(['"]?)\/assets\/([^'"()]+)(['"]?\))/gi,
                    (match, prefix, assetPath, suffix) => {
                        replacementsMade++;
                        return `${prefix}/assets/${assetPath}${suffix}`;
                    }
                );
                
                // Process mask-image URLs differently
                content = content.replace(
                    /(mask-image\s*:\s*url\(['"]?)(https?:\/\/[^'"()]+)(['"]?\))/gi,
                    (match, prefix, url, suffix) => {
                        if (!isAllowedUrl(url)) return match;
                        
                        const relativePath = getRelativePath(url);
                        if (!relativePath) return match;
                        
                        replacementsMade++;
                        return `${prefix}/assets/${url.split('//')[1]}${suffix}`;
                    }
                );
                
                // Save the file if changes were made
                if (originalContent !== content) {
                    fs.writeFileSync(file, content);
                    console.log(`Updated ${replacementsMade} mask image URLs in ${path.relative(OUTPUT_DIR, file)}`);
                    updatedFileCount++;
                }
            } catch (error) {
                console.error(`Error updating mask URLs in ${file}:`, error);
            }
        }
        
        console.log(`\nUpdated mask image URLs in ${updatedFileCount} files`);
        console.log("\n--- Mask-image URL replacements complete ---\n");
    }

    // Function to create the preview-website.bat file in the output directory
    async function createPreviewBatFile() {
        console.log("\n--- Creating preview-website.bat file ---\n");
        
        // Content for the batch file to start a local server
        const batFileContent = `@echo off
echo Starting local server for viewing the archived website...
echo.
echo This will install http-server package temporarily if it's not already installed.
echo.

:: Run the server using npx
npx http-server . -p 8095 -o

:: If there's an error, pause to show the message
if %ERRORLEVEL% neq 0 (
    echo.
    echo Error: Could not start the server. Make sure Node.js is installed.
    pause
    exit /b 1
)

:: The script should remain open as long as the server is running`;

        try {
            // Write the batch file to the output directory
            const batFilePath = path.join(OUTPUT_DIR, 'preview-website.bat');
            fs.writeFileSync(batFilePath, batFileContent);
            console.log(`Created preview batch file: ${batFilePath}`);
        } catch (error) {
            console.error(`Error creating preview batch file: ${error.message}`);
        }
        
        console.log("\n--- Preview batch file creation complete ---\n");
    }

    // Function to create the preview-website.command file for macOS
    async function createPreviewCommandFile() {
        console.log("\n--- Creating preview-website.command file for macOS ---\n");
        
        // Content for the command file to start a local server on macOS
        const commandFileContent = `#!/bin/bash
cd "$(dirname "$0")"

echo "Starting local server for viewing the archived website..."
echo
echo "This will install http-server package temporarily if it's not already installed."
echo

if ! command -v npx &> /dev/null; then
    echo "Error: npx is not installed. Make sure Node.js is installed."
    read -p "Press Enter to exit..."
    exit 1
fi

npx http-server . -p 8095 -o

if [ $? -ne 0 ]; then
    echo "Error: Could not start the server."
    read -p "Press Enter to exit..."
    exit 1
fi

read -p "Server stopped. Press Enter to close..."`;

        try {
            // Write the command file to the output directory
            const commandFilePath = path.join(OUTPUT_DIR, 'preview-website.command');
            fs.writeFileSync(commandFilePath, commandFileContent);
            
            // Make the file executable on Unix-like systems
            try {
                fs.chmodSync(commandFilePath, '755');
                console.log(`Created and made executable the preview command file: ${commandFilePath}`);
            } catch (chmodError) {
                // If chmod fails (e.g., on Windows), just log a message
                console.log(`Created preview command file: ${commandFilePath}`);
                console.log('Note: You may need to make this file executable on macOS with: chmod +x preview-website.command');
            }
        } catch (error) {
            console.error(`Error creating preview command file: ${error.message}`);
        }
        
        console.log("\n--- Preview command file creation complete ---\n");
    }

    console.log(`Starting scraper for ${BASE_URL}`);
    console.log(`Limiting to ${MAX_PAGES} pages`);
    console.log(`Output directory: ${OUTPUT_DIR}/`);
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        let processed = 0;
        
        while (pagesToProcess.length > 0 && (MAX_PAGES === -1 || processed < MAX_PAGES)) {
            const currentUrl = pagesToProcess.shift();
            
            // Process the page and get links
            const links = await processPage(currentUrl, browser);
            
            // Add new links to the processing queue, but normalize URLs first
            for (const link of links) {
                const normalizedLink = normalizeUrl(link);
                // Check if we've already processed this normalized URL or if it's already in the queue
                if (!processedPages.has(normalizedLink) && 
                    !pagesToProcess.some(url => normalizeUrl(url) === normalizedLink)) {
                    pagesToProcess.push(link);
                }
            }
            
            processed++;
        }
        
        // Final pass through all HTML files
        await processAllHtmlFiles();
        
        // Process HTML files with specialized optimization
        await processHtmlFiles();
        
        // Download masked SVG resources before running edge case handling
        await downloadMaskedSvgResources();
        
        // Process JavaScript files for edge cases and special patterns
        await processJsFilesEdgeCases();
        
        // Process CSS files to update URLs
        await processCssFiles();
        
        // Process JavaScript files to update URLs
        await processJsFiles();
        
        // Extract JSON data from Next.js HTML files
        await extractNextJsData();
        
        // Create the preview-website.bat file for Windows
        await createPreviewBatFile();
        
        // Create the preview-website.command file for macOS
        await createPreviewCommandFile();
        
        console.log(`\nScraping complete! Processed ${processed} pages.`);
        console.log(`Website saved to: ${path.resolve(OUTPUT_DIR)}`);
        console.log(`To view the site locally, run: npx http-server ${OUTPUT_DIR} -o`);
        console.log(`Or use one of the preview files in the output folder:`);
        console.log(`  - On Windows: Double-click preview-website.bat`);
        console.log(`  - On macOS: Double-click preview-website.command (you may need to make it executable first)`);
    } catch (error) {
        console.error('Error in scraper:', error);
    } finally {
        await browser.close();
    }
}

module.exports = {
    runScraper
};

if(require.main === module) {
    // Update the example URL to docs.cursor.com
    runScraper({baseUrl: 'https://docs.lovable.dev', maxPages: 3});
}