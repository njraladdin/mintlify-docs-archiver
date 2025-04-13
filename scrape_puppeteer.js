const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const url = require('url');

const BASE_URL = 'https://docs.lovable.dev';
const ALLOWED_DOMAINS = [
    'docs.lovable.dev',
    'mintlify.b-cdn.net',
    'mintlify.s3.us-west-1.amazonaws.com',
    'cdn.jsdelivr.net'
];

const MAX_PAGES = 5; // Maximum number of pages to process (set to -1 for unlimited)
const OUTPUT_DIR = 'website'; // Main output directory

// Set to keep track of processed URLs
const processedPages = new Set();
const processedResources = new Set();
const pagesToProcess = [BASE_URL];

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
        if (parsedUrl.hostname !== 'docs.lovable.dev') {
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

// Function to download a resource
async function downloadResource(resourceUrl, baseUrl) {
    if (processedResources.has(resourceUrl) || !isAllowedUrl(resourceUrl)) {
        return;
    }
    
    try {
        processedResources.add(resourceUrl);
        
        // Resolve relative URLs against the base URL
        const absoluteUrl = new URL(resourceUrl, baseUrl).href;
        const relativePath = getRelativePath(absoluteUrl);
        
        if (!relativePath) return;
        
        // Create the local file path
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
    } catch (error) {
        console.error(`Error downloading ${resourceUrl}:`, error);
    }
}

// Function to update URLs in HTML content
function updateHtmlUrls(content) {
    // Process all HTML attribute values containing URLs
    let updatedContent = content.replace(/(href|src)=["']([^"']+)["']/g, (match, attr, url) => {
        // Skip data URLs and absolute URLs to external domains
        if (url.startsWith('data:') || url.startsWith('http:') || url.startsWith('https:') || url.startsWith('//')) {
            return match;
        }
        
        // For relative URLs, apply our safe path function to each URL segment
        const urlParts = url.split('/');
        const safeUrlParts = urlParts.map(part => safePath(part));
        const safeUrl = safeUrlParts.join('/');
        
        return `${attr}="${safeUrl}"`;
    });
    
    return updatedContent;
}

// Function to process a page and extract all resources
async function processPage(pageUrl, browser) {
    if (processedPages.has(pageUrl) || !isAllowedUrl(pageUrl)) {
        return [];
    }
    
    console.log(`\nProcessing page: ${pageUrl}`);
    processedPages.add(pageUrl);
    
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
            timeout: 30000 
        });
        
        // Get the content of the page
        let content = await page.content();
        
        // Update URLs in HTML content to match our file path encoding
        content = updateHtmlUrls(content);
        
        // Save the HTML file
        const relativePath = getRelativePath(pageUrl);
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
        } catch (writeError) {
            console.error(`Error writing file ${localPath}:`, writeError);
            // If write fails due to directory not existing, try creating again
            if (writeError.code === 'ENOENT') {
                try {
                    fs.mkdirSync(path.dirname(localPath), { recursive: true });
                    // Try writing again after ensuring directory exists
                    fs.writeFileSync(localPath, content);
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
    
    // Process each HTML file
    for (const htmlFile of htmlFiles) {
        try {
            // Read file
            let content = fs.readFileSync(htmlFile, 'utf8');
            
            // Update URLs
            const updatedContent = updateHtmlUrls(content);
            
            // Write back if changed
            if (content !== updatedContent) {
                fs.writeFileSync(htmlFile, updatedContent);
                console.log(`Updated URLs in: ${htmlFile}`);
            }
        } catch (error) {
            console.error(`Error processing HTML file ${htmlFile}:`, error);
        }
    }
    
    console.log("Final HTML processing complete!");
}

// Main function to run the scraper
async function runScraper() {
    console.log(`Starting scraper for ${BASE_URL}`);
    console.log(`Limiting to ${MAX_PAGES} pages`);
    
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
            
            // Add new links to the processing queue
            for (const link of links) {
                if (!processedPages.has(link) && !pagesToProcess.includes(link)) {
                    pagesToProcess.push(link);
                }
            }
            
            processed++;
        }
        
        // Final pass through all HTML files
        await processAllHtmlFiles();
        
        console.log(`\nScraping complete! Processed ${processed} pages.`);
        console.log(`Website saved to: ${path.resolve(OUTPUT_DIR)}`);
        console.log('To view the site locally, run: npx http-server website -o');
    } catch (error) {
        console.error('Error in scraper:', error);
    } finally {
        await browser.close();
    }
}

// Run the scraper
runScraper();
