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
    'mintlify.s3.us-west-1.amazonaws.com',
    'cdn.jsdelivr.net'
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
 * @param {string} filename - Original filename
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

/**
 * Determines if a URL is from an allowed domain
 * @param {string} url - The URL to check
 * @returns {boolean} - Whether the URL is from an allowed domain
 */
function isAllowedDomain(url) {
    try {
        const parsedUrl = new URL(url);
        
        // Always allow CSS and media files regardless of domain
        const lowerUrl = url.toLowerCase();
        const extension = lowerUrl.split('.').pop().split('?')[0];
        
        // Allow all CSS files
        if (lowerUrl.endsWith('.css') || lowerUrl.includes('.css?') || extension === 'css') {
            return true;
        }
        
        // Allow all media files (images, fonts)
        if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif', 'woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) {
            return true;
        }
        
        // For other file types, check against allowed domains
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
 * Collects all resources on a page
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<string[]>} - Array of resource URLs
 */
async function collectPageResources(page) {
        // Set up a request interceptor to capture all resources
        const resourceRequests = new Set();
        page.on('request', request => {
            const url = request.url();
            // For CSS and media, skip domain check, for others check domain
            const lowerUrl = url.toLowerCase();
            const extension = lowerUrl.split('.').pop().split('?')[0];
            const isCssOrMedia = lowerUrl.endsWith('.css') || lowerUrl.includes('.css?') || extension === 'css' || 
                               ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif', 'woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension);
            
            if ((isCssOrMedia || isAllowedDomain(url)) && 
                !url.startsWith('data:') && 
                !url.startsWith('blob:')) {
                resourceRequests.add(url);
            }
        });
        
    // Get page resources from the DOM
        const resources = await page.evaluate((baseUrl) => {
            const items = [];
            
            // Helper function to convert relative URLs to absolute
            function toAbsoluteUrl(url) {
                if (!url) return null;
                // Skip data and blob URLs
                if (url.startsWith('data:') || url.startsWith('blob:')) return null;
                // Already absolute URL
                if (url.startsWith('http://') || url.startsWith('https://')) return url;
                // Site-root-relative URL (starting with /)
                if (url.startsWith('/')) return baseUrl + url;
                // Relative URL - resolve against current page
                const currentPath = window.location.pathname;
                const currentDir = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
                return baseUrl + currentDir + url;
            }
            
            // Get all resources from the page
            document.querySelectorAll('link[rel="stylesheet"], link[data-href], link[data-n-href], style[data-href], style[data-n-href], script[src], img[src], source[src], image, svg image[href], svg use[href], svg [xlink\\:href]').forEach(el => {
                let url;
                if (el.tagName === 'LINK') {
                    // Next.js may use data-href or data-n-href for stylesheets
                    url = el.href || el.getAttribute('data-href') || el.getAttribute('data-n-href');
                } else if (el.tagName === 'STYLE') {
                    // Next.js may store CSS file references in data-href on style elements
                    url = el.getAttribute('data-href') || el.getAttribute('data-n-href');
                } else if (el.tagName === 'SCRIPT') url = el.src;
                else if (el.tagName === 'IMG' || el.tagName === 'SOURCE') url = el.src;
                else if (el.tagName === 'IMAGE' || (el.tagName === 'USE' && el.hasAttribute('href'))) url = el.getAttribute('href');
                else if (el.hasAttribute('xlink:href')) url = el.getAttribute('xlink:href');
                
                const absUrl = toAbsoluteUrl(url);
                if (absUrl) {
                    items.push(absUrl);
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
                                const absUrl = urlMatch && urlMatch[1] ? toAbsoluteUrl(urlMatch[1]) : null;
                                if (absUrl) {
                                    items.push(absUrl);
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
                    const absUrl = urlMatch && urlMatch[1] ? toAbsoluteUrl(urlMatch[1]) : null;
                    if (absUrl) {
                        items.push(absUrl);
                    }
                }
                
                // Get img inside this element if it exists
                const img = el.querySelector('img');
                if (img && img.src) {
                    const absUrl = toAbsoluteUrl(img.src);
                    if (absUrl) {
                        items.push(absUrl);
                    }
                }
            });
            
            // Also look for dynamically loaded resources in inline scripts
            document.querySelectorAll('script:not([src])').forEach(script => {
                const content = script.textContent || '';
                
                // Look for Next.js chunk patterns
                const nextJsChunkPattern = /\/_next\/static\/chunks\/[^"'\s]+/g;
                let match;
                while ((match = nextJsChunkPattern.exec(content)) !== null) {
                    if (match[0]) {
                        const absUrl = toAbsoluteUrl(match[0]);
                        if (absUrl) items.push(absUrl);
                    }
                }
                
                // Look for other JavaScript/CSS files
                const resourcePattern = /(['"])(https?:\/\/[^'"]+\.(js|css)|\/[^'"]+\.(js|css))['"]/g;
                while ((match = resourcePattern.exec(content)) !== null) {
                    if (match[2]) {
                        const absUrl = toAbsoluteUrl(match[2]);
                        if (absUrl) items.push(absUrl);
                    }
                }
                
                // Look for image files - be extra thorough with SVG files
                const imagePattern = /(['"])(https?:\/\/[^'"]+\.(png|jpg|jpeg|gif|svg|webp|avif)|\/[^'"]+\.(png|jpg|jpeg|gif|svg|webp|avif))['"]/g;
                while ((match = imagePattern.exec(content)) !== null) {
                    if (match[2]) {
                        const absUrl = toAbsoluteUrl(match[2]);
                        if (absUrl) items.push(absUrl);
                    }
                }
                
                // Look for Mintlify CDN references
                const mintlifyCdnPattern = /(['"])(https?:\/\/mintlify[^'"]+)['"]/g;
                while ((match = mintlifyCdnPattern.exec(content)) !== null) {
                    if (match[2]) {
                        const absUrl = toAbsoluteUrl(match[2]);
                        if (absUrl) items.push(absUrl);
                    }
                }
                
                // Look for common image directory patterns
                const imageDirPattern = /(['"])(https?:\/\/[^'"]+\/images\/[^'"]+|\/images\/[^'"]+)['"]/g;
                while ((match = imageDirPattern.exec(content)) !== null) {
                    if (match[2]) {
                        const absUrl = toAbsoluteUrl(match[2]);
                        if (absUrl) items.push(absUrl);
                    }
                }
            });
            
            // Get Next.js data if available
            const nextData = document.getElementById('__NEXT_DATA__');
            if (nextData) {
                try {
                    const data = JSON.parse(nextData.textContent);
                    if (data.buildId) {
                        const buildManifest = toAbsoluteUrl(`/_next/static/${data.buildId}/_buildManifest.js`);
                        const ssgManifest = toAbsoluteUrl(`/_next/static/${data.buildId}/_ssgManifest.js`);
                        if (buildManifest) items.push(buildManifest);
                        if (ssgManifest) items.push(ssgManifest);
                    }
                } catch (e) {
                    console.error('Error parsing Next.js data:', e);
                }
            }
            
            // Specifically handle Next.js style pattern mentioned in the user's example
            document.querySelectorAll('noscript[data-n-css]').forEach(noscript => {
                // Check if there's a neighboring style with data-n-href
                const styleTag = noscript.nextElementSibling;
                if (styleTag && styleTag.tagName === 'STYLE' && styleTag.hasAttribute('data-n-href')) {
                    const cssUrl = styleTag.getAttribute('data-n-href');
                    const absUrl = toAbsoluteUrl(cssUrl);
                    if (absUrl) {
                        items.push(absUrl);
                    }
                }
                
                // Also look for href in the noscript content
                const content = noscript.textContent || '';
                const hrefMatches = content.match(/href="([^"]+)"/g);
                if (hrefMatches) {
                    hrefMatches.forEach(match => {
                        const url = match.replace(/href="([^"]+)"/, '$1');
                        const absUrl = toAbsoluteUrl(url);
                        if (absUrl) {
                            items.push(absUrl);
                        }
                    });
                }
            });
            
            // Also extract all style tags with a data-href attribute
            document.querySelectorAll('style[data-href]').forEach(style => {
                const cssUrl = style.getAttribute('data-href');
                const absUrl = toAbsoluteUrl(cssUrl);
                if (absUrl) {
                    items.push(absUrl);
                }
            });
            
            return [...new Set(items)]; // Return unique items
        }, BASE_URL);
        
        // Add explicit Next.js CSS pattern extraction from HTML content
        const pageHtml = await page.content();
        const nextCssPattern = /_next\/static\/css\/[^"']+\.css/g;
        let cssMatch;
        while ((cssMatch = nextCssPattern.exec(pageHtml)) !== null) {
            const cssPath = cssMatch[0];
            const fullCssUrl = BASE_URL + '/' + cssPath.replace(/^\//, '');
            resources.push(fullCssUrl);
        }
        
        // Add resources from intercepted requests
        resources.push(...resourceRequests);
        
    // Make resources unique and return
    return [...new Set(resources)];
}

/**
 * Collects all navigation links on a page
 * @param {Object} page - Puppeteer page object
 * @param {string} baseUrl - Base URL of the site
 * @returns {Promise<Object[]>} - Array of navigation link objects
 */
async function collectNavigationLinks(page, baseUrl) {
    return await page.evaluate((baseUrl) => {
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
}

/**
 * Saves the HTML content of a page
 * @param {Object} page - Puppeteer page object
 * @param {string} urlPath - Path of the page
 * @param {string} outputDir - Directory to save the HTML file
 * @returns {Promise<string>} - Path to the saved HTML file
 */
async function savePageHtml(page, urlPath, outputDir) {
    try {
        // Create a safe filename for the HTML
        const filename = urlPath === '/' ? 'index.html' : 
            urlPath.replace(/^\//, '').replace(/\//g, '-') + '.html';
        
        const filePath = path.join(outputDir, filename);
        
        // Get the HTML content
        const htmlContent = await page.content();
        
        // Save the HTML file
        await fs.writeFile(filePath, htmlContent);
        
        console.log(`Saved HTML: ${filePath}`);
        
        return filePath;
    } catch (error) {
        console.error(`Error saving HTML for ${urlPath}: ${error.message}`);
        return null;
    }
}

/**
 * Process a single page using Puppeteer
 * @param {Object} page - Puppeteer page object
 * @param {string} urlPath - Path to process
 * @param {Set<string>} processedPaths - Already processed paths
 * @param {Set<string>} pathsToProcess - Paths to process
 * @param {Object} collectedData - Object to store collected data
 * @returns {Promise<void>}
 */
async function processPage(page, urlPath, processedPaths, pathsToProcess, collectedData) {
    const fullUrl = BASE_URL + urlPath;
    
    console.log(`Processing: ${fullUrl}`);

    // Skip if already processed
    if (processedPaths.has(urlPath)) {
        console.log(`Already processed: ${urlPath}`);
                            return;
                        }
                        
    // Mark as processed
    processedPaths.add(urlPath);
    
    // Initialize data structure for this page
    const pageData = {
        url: fullUrl,
        path: urlPath,
        title: '',
        htmlFile: null,
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
        
        // Save the HTML content
        const htmlFilePath = await savePageHtml(page, urlPath, OUTPUT_DIR);
        if (htmlFilePath) {
            pageData.htmlFile = path.relative(OUTPUT_DIR, htmlFilePath);
        }
        
        // Collect all resources on the page
        const uniqueResources = await collectPageResources(page);
        
        if (DEBUG) {
            console.log(`Found ${uniqueResources.length} resources on the page`);
        }
        
        // Collect all internal links
        const internalLinks = await collectNavigationLinks(page, BASE_URL);
        
        // Store navigation links
        pageData.navigationLinks = internalLinks;
        
        // Add links to processing queue
        for (const link of internalLinks) {
            if (!processedPaths.has(link.path) && !pathsToProcess.has(link.path)) {
                console.log(`Queueing: ${link.path}`);
                pathsToProcess.add(link.path);
            }
        }
        
        // Process and categorize resources (but don't download yet)
        for (const url of uniqueResources) {
            // Get category first
            const category = categorizeResource(url);
            const isCssOrMedia = category === 'css' || category === 'image' || category === 'font';
            
            // Allow all CSS and media files regardless of domain
            if (isCssOrMedia || isAllowedDomain(url)) {
                // Store resource in appropriate category array
                const resource = {
                    url: url,
                    category: category,
                    localPath: null, // Will be filled during download phase
                    downloaded: false
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
        
        // Add this page's data to the collected data
        collectedData.pages.push(pageData);
        
        // Update total resource counts
        collectedData.stats.totalPages++;
        collectedData.stats.totalResources.css += pageData.resources.css.length;
        collectedData.stats.totalResources.js += pageData.resources.js.length;
        collectedData.stats.totalResources.images += pageData.resources.images.length;
        collectedData.stats.totalResources.fonts += pageData.resources.fonts.length;
        collectedData.stats.totalResources.other += pageData.resources.other.length;
        
        // Add unique paths to the set of all navigation paths
        internalLinks.forEach(link => {
            collectedData.allNavigationPaths.add(link.path);
        });
        
            } catch (error) {
        console.error(`Error processing ${fullUrl}:`, error.message);
        console.error(error.stack);
        
        // Still add the page to the data but mark it as error
        pageData.error = error.message;
        collectedData.pages.push(pageData);
        collectedData.stats.pagesWithErrors++;
    }
}

/**
 * Downloads all resources collected from pages
 * @param {Object} collectedData - The data collected from all pages
 * @returns {Promise<void>}
 */
async function downloadAllResources(collectedData) {
    console.log("\n--- Starting resource download phase ---\n");
    
    // Create a flat list of all resources to download
    const allResources = [];
    
    // Collect all resources from all pages
    for (const page of collectedData.pages) {
        ['css', 'js', 'images', 'fonts', 'other'].forEach(category => {
            allResources.push(...page.resources[category]);
        });
    }
    
    // Remove duplicates by URL
    const uniqueUrls = new Set();
    const uniqueResources = allResources.filter(resource => {
        if (uniqueUrls.has(resource.url)) {
            return false;
        }
        uniqueUrls.add(resource.url);
        return true;
    });
    
    console.log(`Found ${uniqueResources.length} unique resources to download`);
    
    // Download in batches to avoid overwhelming the server
    const batchSize = 5;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    
    for (let i = 0; i < uniqueResources.length; i += batchSize) {
        const batch = uniqueResources.slice(i, i + batchSize);
        
        // Download this batch
        await Promise.all(batch.map(async (resource) => {
            try {
                const result = await downloadResource(resource.url, resource.category);
                
                // Update all instances of this resource in our data structure
                if (result.success) {
                    const relativeFilePath = path.relative(OUTPUT_DIR, result.filePath);
                    
                    // Update all references to this resource
                    for (const page of collectedData.pages) {
                        for (const category of ['css', 'js', 'images', 'fonts', 'other']) {
                            page.resources[category].forEach(res => {
                                if (res.url === resource.url) {
                                    res.localPath = relativeFilePath;
                                    res.downloaded = true;
                                }
                            });
                        }
                    }
                    succeeded++;
                    } else {
                    // Mark as failed in all instances
                    for (const page of collectedData.pages) {
                        for (const category of ['css', 'js', 'images', 'fonts', 'other']) {
                            page.resources[category].forEach(res => {
                                if (res.url === resource.url) {
                                    res.downloaded = false;
                                    res.error = result.error;
                                }
                        });
                    }
                }
                    failed++;
                }
            } catch (error) {
                console.error(`Error downloading ${resource.url}: ${error.message}`);
                failed++;
            }
            
            completed++;
            if (completed % 10 === 0 || completed === uniqueResources.length) {
                console.log(`Downloaded ${completed}/${uniqueResources.length} resources (${succeeded} succeeded, ${failed} failed)`);
            }
        }));
        
        console.log(`Completed batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(uniqueResources.length/batchSize)}`);
    }
    
    // Update stats
    collectedData.stats.downloadStatus.success = succeeded;
    collectedData.stats.downloadStatus.failed = failed;
    
    console.log("\n--- Resource download phase complete ---\n");
    return { succeeded, failed };
}

// Main execution function
async function main() {
    const maxPages = MAX_PAGES;
    console.log(`Starting scraper with max pages set to: ${maxPages < 0 ? 'unlimited' : maxPages}`);
    
    // Create output directories
    await ensureOutputDir(OUTPUT_DIR);
    await ensureOutputDir(CSS_DIR);
    await ensureOutputDir(JS_DIR);
    await ensureOutputDir(ASSETS_DIR);
    await ensureOutputDir(FONTS_DIR);
    
    // Initialize data collection object
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
    
    // Phase 1: Crawl all pages and collect data
    console.log("\n--- Starting page crawling phase ---\n");
    
    // Launch a single browser instance
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
            await processPage(page, currentPath, processedPaths, pathsToProcess, collectedData);
            processedCount++;
            
            // Show progress
            console.log(`\nProgress: ${processedCount}/${maxPages < 0 ? '∞' : maxPages} pages processed, ${pathsToProcess.size} pages in queue\n`);
        }
        
        console.log("\n--- Page crawling phase complete ---\n");
        console.log(`Processed ${processedCount} pages out of ${maxPages < 0 ? 'unlimited' : maxPages}.`);
        
    } finally {
        // Close browser after all pages are processed
        await browser.close();
    }
    
    // Convert Set to Array for JSON serialization
    collectedData.allNavigationPaths = Array.from(collectedData.allNavigationPaths);
    
    // Calculate total resources before download
    const totalResources = 
        collectedData.stats.totalResources.css + 
        collectedData.stats.totalResources.js + 
        collectedData.stats.totalResources.images + 
        collectedData.stats.totalResources.fonts + 
        collectedData.stats.totalResources.other;
        
    collectedData.stats.totalResourcesCount = totalResources;
    
    // Phase 2: Download all resources
    const { succeeded, failed } = await downloadAllResources(collectedData);
    
    // Phase 3: Save the final data
    const outputFile = path.join(OUTPUT_DIR, 'collected-data.json');
    await fs.writeFile(outputFile, JSON.stringify(collectedData, null, 2));
    console.log(`Saved collected data to ${outputFile}`);
    
    console.log("\nData collection and download complete.");
    console.log(`Successfully downloaded ${succeeded} resources.`);
    console.log(`Failed to download ${failed} resources.`);
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