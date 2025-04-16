const fs = require('fs/promises');
const path = require('path');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { URL } = require('url');
const cheerio = require('cheerio');

// --- Configuration ---
const BASE_URL = 'https://docs.cursor.com';
const ALLOWED_DOMAINS = [
    'docs.cursor.com',
    'mintlify.b-cdn.net',
    'mintlify.s3.us-west-1.amazonaws.com'
];
const START_PATH = '/introduction';
const OUTPUT_DIR = 'output';
const CSS_DIR = 'css';
const JS_DIR = 'js';
const ASSETS_DIR = 'assets';
const WAIT_TIME = 3000; // Time to wait for page to fully load in ms
const MAX_PAGES = 5; // Maximum number of pages to process (set to -1 for unlimited)
const DEBUG = true; // Enable debug logging

// User agent for requests
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

/**
 * Creates the output directory if it doesn't exist.
 * @param {string} dirPath - The path to the directory.
 */
async function ensureOutputDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
        console.log(`Output directory "${dirPath}" ensured.`);
    } catch (error) {
        console.error(`Error creating output directory "${dirPath}":`, error);
        throw error;
    }
}

/**
 * Converts a URL path into a safe filename.
 * @param {string} urlPath - The relative URL path.
 * @returns {string} A safe filename ending with .html.
 */
function urlPathToFilename(urlPath) {
    if (!urlPath || urlPath === '/') {
        return 'index.html';
    }
    
    // Handle trailing slashes for directory-like paths
    if (urlPath.endsWith('/')) {
        const dirPath = urlPath.substring(0, urlPath.length - 1);
        return `${dirPath.substring(1).replace(/\//g, '-')}-index.html`;
    }
    
    // Remove leading slash, replace other slashes with hyphens
    const safeName = urlPath.substring(1).replace(/\//g, '-');
    // Add .html extension if not already present
    return safeName.endsWith('.html') ? safeName : `${safeName}.html`;
}

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
 * Makes a filename safe by replacing forbidden characters
 * @param {string} filename - Original filename
 * @returns {string} Safe filename
 */
function makeSafeFilename(filename) {
    return filename.replace(/[^a-z0-9.-]/gi, '_').substring(0, 200); // Limit length for safety
}

/**
 * Returns the appropriate output directory for a resource based on its type
 * @param {string} url - Resource URL
 * @param {Object} outputDirs - Output directories by type
 * @returns {string} - Path to the appropriate output directory
 */
function getOutputDirForResource(url, outputDirs) {
    const extension = path.extname(url).toLowerCase();
    if (['.css'].includes(extension)) {
        return outputDirs.css;
    } else if (['.js', '.mjs'].includes(extension)) {
        return outputDirs.js;
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif'].includes(extension)) {
        return outputDirs.assets;
    } else if (['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(extension)) {
        return outputDirs.assets;
    } else if (url.includes('/static/media/') || url.includes('/images/')) {
        // Common patterns for image paths even without extensions
        return outputDirs.assets;
    } else {
        // Default to js for unknown types (they're often JavaScript modules)
        return outputDirs.js;
    }
}

/**
 * Creates a safe local path for a resource
 * @param {string} url - The original URL
 * @param {Object} outputDirs - Output directories mapping
 * @returns {Object} Object with filePath and outputDir
 */
function createLocalPath(url, outputDirs) {
    try {
        const parsedUrl = new URL(url);
        const urlPath = parsedUrl.pathname;
        const hostname = parsedUrl.hostname;
        
        // Create a reasonable filename
        let filename = path.basename(urlPath);
        if (!filename || filename === '' || filename === '/') {
            // Try to create a more descriptive filename
            const urlParts = urlPath.split('/').filter(Boolean);
            filename = urlParts.length > 0 ? urlParts[urlParts.length - 1] : 'resource';
            
            // Add extension based on URL patterns
            if (url.includes('.png')) filename += '.png';
            else if (url.includes('.jpg') || url.includes('.jpeg')) filename += '.jpg';
            else if (url.includes('.svg')) filename += '.svg';
            else if (url.includes('.css')) filename += '.css';
            else if (url.includes('.js')) filename += '.js';
            else filename += path.extname(urlPath) || '';
        }
        
        // For CDN resources, include part of the hostname in the filename
        // to avoid collisions with resources from different CDNs
        let safeFilename;
        if (hostname !== new URL(BASE_URL).hostname) {
            // For external domains, add hostname to make filename unique
            safeFilename = `${hostname.replace(/\./g, '_')}_${urlPath.replace(/[^a-z0-9]/gi, '_')}_${makeSafeFilename(filename)}`;
        } else {
            safeFilename = `${urlPath.replace(/[^a-z0-9]/gi, '_')}_${makeSafeFilename(filename)}`;
        }
        
        // Determine appropriate directory
        const outputDir = getOutputDirForResource(url, outputDirs);
        
        // Full path
        const filePath = path.join(outputDir, safeFilename);
        
        return {
            filePath,
            outputDir: path.basename(outputDir),
            safeFilename
        };
    } catch (e) {
        console.error(`Error creating local path for ${url}: ${e.message}`);
        return null;
    }
}

/**
 * Process a single page using Puppeteer
 * @param {Object} page - Puppeteer page object
 * @param {string} urlPath - Path to process
 * @param {Object} outputDirs - Output directories
 * @param {Set<string>} processedPaths - Already processed paths
 * @param {Set<string>} pathsToProcess - Paths to process
 * @param {Set<string>} resourcesToDownload - Set to store resources
 * @param {Map<string, Object>} resourcePaths - Map of original URLs to local paths
 * @returns {Promise<void>}
 */
async function processPage(page, urlPath, outputDirs, processedPaths, pathsToProcess, resourcesToDownload, resourcePaths) {
    const fullUrl = BASE_URL + urlPath;
    const outputFile = path.join(outputDirs.html, urlPathToFilename(urlPath));
    
    console.log(`Processing: ${fullUrl}`);
    console.log(`Output file will be: ${outputFile}`);

    // Skip if already processed
    if (processedPaths.has(urlPath)) {
        console.log(`Already processed: ${urlPath}`);
        return;
    }
    
    // Mark as processed
    processedPaths.add(urlPath);
    
    try {
        // Navigate to the page
        console.log(`Navigating to: ${fullUrl}`);
        await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait a bit more for dynamic content
        await new Promise(resolve => setTimeout(resolve, WAIT_TIME));
        console.log(`Finished waiting for dynamic content`);
        
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
        
        // Get page resources
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
        
        if (DEBUG) {
            console.log(`Found ${resources.length} resources on the page`);
        }
        
        // Add these resources to our download list and create paths for them
        resources.forEach(url => {
            if (isAllowedDomain(url)) {
                resourcesToDownload.add(url);
                
                // Create and store the local path mapping for this resource if we don't have it yet
                if (!resourcePaths.has(url)) {
                    const localPath = createLocalPath(url, outputDirs);
                    if (localPath) {
                        resourcePaths.set(url, localPath);
                    }
                }
            }
        });
        
        // Collect all internal links
        const internalLinks = await page.evaluate((baseUrl) => {
            const links = new Set();
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
                    links.add(urlObj.pathname);
                } catch (e) {
                    console.error('Error parsing URL:', e);
                }
            });
            return Array.from(links);
        }, BASE_URL);
        
        // Add links to processing queue
        for (const link of internalLinks) {
            if (!processedPaths.has(link) && !pathsToProcess.has(link)) {
                console.log(`Queueing: ${link}`);
                pathsToProcess.add(link);
            }
        }
        
        // Get HTML content
        let html = await page.content();
        console.log(`Retrieved page HTML content (${html.length} bytes)`);
        
        // Update all URLs to be relative
        html = html.replace(new RegExp(BASE_URL, 'g'), '.');
        
        // Determine the absolute path to the output directory
        const absoluteOutputDir = path.resolve(outputDirs.html);
        console.log(`Absolute output directory: ${absoluteOutputDir}`);
        
        // Create a map of URL paths to absolute file paths
        const urlPathMap = new Map();
        for (const pathItem of [...processedPaths, ...pathsToProcess]) {
            const htmlFilename = urlPathToFilename(pathItem);
            // Use proper file URL format with triple backslashes for Windows paths
            const absoluteFilePath = `file:///${absoluteOutputDir.replace(/\\/g, '/').replace(/^[A-Za-z]:/, (match) => match.toLowerCase())}/${htmlFilename}`;
            urlPathMap.set(pathItem, absoluteFilePath);
            console.log(`[URL MAP] ${pathItem} -> ${absoluteFilePath}`);
        }
        
        console.log(`Created URL path map with ${urlPathMap.size} entries`);
        
        // Use Cheerio to parse and modify the HTML
        console.log("Using Cheerio to parse and update HTML links...");
        const $ = cheerio.load(html);
        
        // Count of updated links
        let updatedLinkCount = 0;
        
        // Process all links (<a> tags with href attributes)
        $('a[href]').each((i, el) => {
            const href = $(el).attr('href');
                    if (href && href.startsWith('/')) {
                const absolutePath = urlPathMap.get(href);
                if (absolutePath) {
                    $(el).attr('href', absolutePath);
                    console.log(`[CHEERIO] Updated link: ${href} -> ${absolutePath}`);
                    updatedLinkCount++;
                } else {
                    console.log(`[CHEERIO WARNING] No mapping found for href="${href}"`);
                }
            }
        });
        
        console.log(`Updated ${updatedLinkCount} links using Cheerio`);
        
        // Also process elements with path IDs
        let updatedIdCount = 0;
        $('[id^="/"]').each((i, el) => {
            const id = $(el).attr('id');
            const absolutePath = urlPathMap.get(id);
            if (absolutePath) {
                $(el).attr('data-local-file', absolutePath);
               // console.log(`[CHEERIO] Added data-local-file="${absolutePath}" to element with id="${id}"`);
                updatedIdCount++;
            }
        });
        
        console.log(`Updated ${updatedIdCount} elements with path IDs using Cheerio`);
        
        // Specifically fix the navigation sidebar links (matching the pattern the user showed)
        $('li[id^="/"] a[href^="/"]').each((i, el) => {
            const href = $(el).attr('href');
            const absolutePath = urlPathMap.get(href);
            if (absolutePath) {
                $(el).attr('href', absolutePath);
                console.log(`[CHEERIO] Fixed navigation sidebar link: ${href} -> ${absolutePath}`);
            }
        });
        
        // Get the modified HTML
        html = $.html();
        
        // Add helper script for interactive elements
        html = html.replace('</body>', `
        <script>
            // Offline Helper Script
            console.log("Initializing offline helper script");
            
            // Debug info about the current page
            console.log("Current page URL:", window.location.href);
            console.log("Current page pathname:", window.location.pathname);
            
            // URL path map
            const urlPathMap = ${JSON.stringify(Object.fromEntries(urlPathMap), null, 2)};
            console.log("URL Path Map initialized with", Object.keys(urlPathMap).length, "entries");
            
            document.addEventListener('DOMContentLoaded', function() {
                console.log("DOM loaded, starting navigation fixes");
                
                // Double-check all links to make sure they're fixed
                const links = document.querySelectorAll('a[href]');
                console.log("Found", links.length, "links to check");
                
                let fixedLinks = 0;
                links.forEach(function(link) {
                    const href = link.getAttribute('href');
                    if (href && href.startsWith('/')) {
                        console.log("Found unfixed link with href", href);
                        const absolutePath = urlPathMap[href];
                        if (absolutePath) {
                            link.setAttribute('href', absolutePath);
                            console.log('Fixed link at runtime:', href, '->', absolutePath);
                            
                            link.addEventListener('click', function(e) {
                        e.preventDefault();
                                console.log("Navigating to", absolutePath);
                                window.location.href = absolutePath;
                            });
                            fixedLinks++;
                        } else {
                            console.error("No mapping found for href", href);
                        }
                    }
                });
                console.log("Fixed", fixedLinks, "navigation links at runtime");
            });
        </script>
        </body>`);
        
        // Save HTML file
        console.log(`Writing HTML to file: ${outputFile}`);
        await fs.writeFile(outputFile, html);
        console.log(`Saved HTML: ${outputFile}`);
        
        // Enhanced CSS detection
        await page.evaluate(() => {
            // Force browser to load all stylesheets completely
            const sheets = Array.from(document.styleSheets);
            sheets.forEach(sheet => {
                try {
                    // Access cssRules to force loading
                    const rules = Array.from(sheet.cssRules);
                    console.log(`Loaded ${rules.length} CSS rules from ${sheet.href || 'inline style'}`);
                } catch (e) {
                    // CORS errors are expected for external stylesheets
                    console.log(`Could not access rules for ${sheet.href || 'inline style'}: ${e.message}`);
                }
            });
        });
        
        // Additional CSS detection by directly checking network requests
        const stylesheetLinks = await page.evaluate(() => {
            const sheets = [];
            // Get all CSS links
            document.querySelectorAll('link[rel="stylesheet"][href], link[as="style"][href]').forEach(link => {
                if (link.href && !link.href.startsWith('data:')) {
                    sheets.push(link.href);
                }
            });
            return sheets;
        });
        
        // Make sure all detected stylesheets are in our resource list
        stylesheetLinks.forEach(url => {
            if (isAllowedDomain(url)) {
                console.log(`Adding CSS file to download queue: ${url}`);
                resourcesToDownload.add(url);
                
                // Create path mapping if it doesn't exist
                if (!resourcePaths.has(url)) {
                    const localPath = createLocalPath(url, outputDirs);
                    if (localPath) {
                        resourcePaths.set(url, localPath);
                    }
                }
            }
        });
        
    } catch (error) {
        console.error(`Error processing ${fullUrl}:`, error.message);
        console.error(error.stack);
    }
}

/**
 * Download all resources with axios
 * @param {Set<string>} resources - Set of resource URLs
 * @param {Map<string, Object>} resourcePaths - Map of original URLs to local paths
 * @param {Object} outputDirs - Output directories configuration
 * @returns {Promise<void>}
 */
async function downloadAllResources(resources, resourcePaths, outputDirs) {
    console.log(`Downloading ${resources.size} resources...`);
    
    // Filter out any potentially invalid URLs
    const validResources = new Set();
    for (const url of resources) {
        try {
            new URL(url); // This will throw if URL is invalid
            validResources.add(url);
        } catch (e) {
            console.error(`Skipping invalid URL: ${url}`);
        }
    }
    
    // Add CSS files at the beginning of the queue for priority processing
    // This ensures CSS files are processed first, which helps with dependent resources
    const urls = Array.from(validResources);
    urls.sort((a, b) => {
        const aIsCss = a.endsWith('.css') || a.includes('.css?');
        const bIsCss = b.endsWith('.css') || b.includes('.css?');
        if (aIsCss && !bIsCss) return -1;
        if (!aIsCss && bIsCss) return 1;
        return 0;
    });
    
    console.log(`Proceeding with download of ${urls.length} valid resources`);
    
    // Track CSS files we've already processed to avoid duplicates
    const processedCssFiles = new Set();
    // Set to track all URLs discovered in CSS files that need to be downloaded
    const cssResourceUrls = new Set();
    
    // Process files in batches to avoid overwhelming the server
    const batchSize = 5;
    let completed = 0;
    let failed = 0;
    
    for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        await Promise.all(batch.map(async (url) => {
            const localInfo = resourcePaths.get(url);
            if (localInfo) {
                try {
                    // Determine if this is a CSS file
                    const isCssFile = url.endsWith('.css') || url.includes('.css?');
                    const responseType = isCssFile ? 'text' : 'arraybuffer';
                    
                    console.log(`Downloading: ${url} (${isCssFile ? 'CSS' : 'binary'})`);
                    
                    const response = await axios.get(url, {
                        responseType,
                        headers: {
                            'User-Agent': USER_AGENT,
                            'Accept': getAcceptHeaderForUrl(url),
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Referer': BASE_URL,
                            'Origin': BASE_URL
                        },
                        maxRedirects: 5,
                        timeout: 15000 // Increased timeout for potentially slow CSS resources
                    });
                    
                    // Process CSS files to handle @import and url() references
                    if (isCssFile) {
                        // Don't process the same CSS file twice
                        if (processedCssFiles.has(url)) {
                            console.log(`Already processed CSS file: ${url}`);
                            completed++;
                            return;
                        }
                        
                        processedCssFiles.add(url);
                        
                        // Get the CSS content
                        let cssContent = response.data;
                        console.log(`CSS file ${url} length: ${cssContent.length} bytes`);
                        
                        // Extract all font URLs from @font-face definitions
                        const fontUrlMatches = [...cssContent.matchAll(/src\s*:\s*(?:[^;]*url\s*\(\s*['"]?([^'"\)]+)['"]?\s*\))+/g)];
                        for (const fontMatch of fontUrlMatches) {
                            const fontUrls = fontMatch[0].match(/url\s*\(\s*['"]?([^'"\)]+)['"]?\s*\)/g) || [];
                            for (const fontUrlMatch of fontUrls) {
                                let fontUrl = fontUrlMatch.match(/url\s*\(\s*['"]?([^'"\)]+)['"]?\s*\)/)[1];
                                
                                // Skip data URLs
                                if (fontUrl.startsWith('data:')) continue;
                                
                                // Handle relative URLs
                                if (!fontUrl.startsWith('http')) {
                                    try {
                                        const baseUrl = new URL(url);
                                        fontUrl = new URL(fontUrl, baseUrl.origin + baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1)).href;
                                    } catch (e) {
                                        console.error(`Error resolving font URL ${fontUrl}: ${e.message}`);
                                        continue;
                                    }
                                }
                                
                                console.log(`Found font URL in CSS: ${fontUrl}`);
                                cssResourceUrls.add(fontUrl);
                                
                                // Create a local path for this resource if it doesn't exist
                                if (!resourcePaths.has(fontUrl)) {
                                    const fontLocalPath = createLocalPath(fontUrl, outputDirs);
                                    if (fontLocalPath) {
                                        resourcePaths.set(fontUrl, fontLocalPath);
                                    }
                                }
                                
                                // Update the CSS reference
                                const localFontInfo = resourcePaths.get(fontUrl);
                                if (localFontInfo) {
                                    const fontPath = `../${localFontInfo.outputDir}/${localFontInfo.safeFilename}`;
                                    cssContent = cssContent.replace(
                                        new RegExp(`url\\(\\s*['"]?${escapeRegExp(fontUrl)}['"]?\\s*\\)`, 'g'),
                                        `url('${fontPath}')`
                                    );
                                    console.log(`Updated CSS font reference: ${fontUrl} -> ${fontPath}`);
                                }
                            }
                        }
                        
                        // Extract and download all url() resources in the CSS
                        const urlMatches = [...cssContent.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g)];
                        
                        for (const match of urlMatches) {
                            let cssResourceUrl = match[1];
                            
                            // Skip data URLs and font URLs already processed
                            if (cssResourceUrl.startsWith('data:')) continue;
                            
                            // Handle relative URLs
                            if (!cssResourceUrl.startsWith('http')) {
                                try {
                                    const baseUrl = new URL(url);
                                    cssResourceUrl = new URL(cssResourceUrl, baseUrl.origin + baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1)).href;
                                } catch (e) {
                                    console.error(`Error resolving CSS resource URL ${cssResourceUrl}: ${e.message}`);
                                    continue;
                                }
                            }
                            
                            // Only process allowed domains
                            if (!isAllowedDomain(cssResourceUrl)) continue;
                            
                            console.log(`Found CSS resource: ${cssResourceUrl}`);
                            cssResourceUrls.add(cssResourceUrl);
                            
                            // Add to download queue if not already in resourcePaths
                            if (!resourcePaths.has(cssResourceUrl)) {
                                const cssResourceLocalPath = createLocalPath(cssResourceUrl, outputDirs);
                                if (cssResourceLocalPath) {
                                    resourcePaths.set(cssResourceUrl, cssResourceLocalPath);
                                }
                            }
                            
                            // Update CSS content with local path
                            const localResourceInfo = resourcePaths.get(cssResourceUrl);
                            if (localResourceInfo) {
                                const resourcePath = `../${localResourceInfo.outputDir}/${localResourceInfo.safeFilename}`;
                                cssContent = cssContent.replace(
                                    new RegExp(`url\\(['"]?${escapeRegExp(match[1])}['"]?\\)`, 'g'),
                                    `url('${resourcePath}')`
                                );
                                console.log(`Updated CSS reference: ${match[1]} -> ${resourcePath}`);
                            }
                        }
                        
                        // Handle @import rules to download additional CSS files
                        const importMatches = [...cssContent.matchAll(/@import\s+(?:url\(['"]?([^'")\s]+)['"]?\)|['"]([^'"]+)['"]);/g)];
                        
                        for (const match of importMatches) {
                            let importUrl = match[1] || match[2]; // match[1] is for url() format, match[2] is for quoted format
                            
                            // Handle relative URLs
                            if (!importUrl.startsWith('http')) {
                                try {
                                    const baseUrl = new URL(url);
                                    importUrl = new URL(importUrl, baseUrl.origin + baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1)).href;
                                } catch (e) {
                                    console.error(`Error resolving @import URL ${importUrl}: ${e.message}`);
                                    continue;
                                }
                            }
                            
                            // Only process allowed domains
                            if (!isAllowedDomain(importUrl)) continue;
                            
                            console.log(`Found @import: ${importUrl}`);
                            cssResourceUrls.add(importUrl);
                            
                            // Add to download queue if not already in resourcePaths
                            if (!resourcePaths.has(importUrl)) {
                                const importLocalPath = createLocalPath(importUrl, outputDirs);
                                if (importLocalPath) {
                                    resourcePaths.set(importUrl, importLocalPath);
                                }
                            }
                            
                            // Update CSS content with local path
                            const localImportInfo = resourcePaths.get(importUrl);
                            if (localImportInfo) {
                                const importPath = `../${localImportInfo.outputDir}/${localImportInfo.safeFilename}`;
                                cssContent = cssContent.replace(
                                    new RegExp(`@import\\s+(?:url\\(['"]?${escapeRegExp(importUrl)}['"]?\\)|['"]${escapeRegExp(importUrl)}['"])`, 'g'),
                                    `@import url('${importPath}')`
                                );
                                console.log(`Updated CSS @import: ${importUrl} -> ${importPath}`);
                            }
                        }
                        
                        // Write the updated CSS content
                        await fs.writeFile(localInfo.filePath, cssContent);
                        console.log(`Saved updated CSS: ${localInfo.filePath}`);
                    } else {
                        // Save binary content directly for non-CSS files
                        await fs.writeFile(localInfo.filePath, response.data);
                    }
                    
                    console.log(`Saved: ${localInfo.filePath}`);
                    completed++;
                } catch (error) {
                    console.error(`Error downloading ${url}: ${error.message}`);
                    failed++;
                }
                
                if ((completed + failed) % 10 === 0) {
                    console.log(`Downloaded ${completed}/${urls.length} resources (${failed} failed)`);
                }
            }
        }));
    }
    
    console.log(`Completed downloading ${completed}/${urls.length} resources (${failed} failed)`);
    
    // Process all the CSS resources we found
    if (cssResourceUrls.size > 0) {
        console.log(`Found ${cssResourceUrls.size} additional resources in CSS files, downloading them now...`);
        for (const cssResource of cssResourceUrls) {
            if (!resourcePaths.has(cssResource)) continue;
            
            const localInfo = resourcePaths.get(cssResource);
            try {
                const response = await axios.get(cssResource, {
                    responseType: 'arraybuffer',
                    headers: {
                        'User-Agent': USER_AGENT,
                        'Accept': getAcceptHeaderForUrl(cssResource),
                        'Referer': BASE_URL,
                        'Origin': BASE_URL
                    },
                    maxRedirects: 5,
                    timeout: 10000
                });
                
                await fs.writeFile(localInfo.filePath, response.data);
                console.log(`Saved CSS resource: ${localInfo.filePath}`);
            } catch (error) {
                console.error(`Error downloading CSS resource ${cssResource}: ${error.message}`);
            }
        }
    }
}

/**
 * Helper function to escape special characters in a string for use in a regular expression
 * @param {string} string - The string to escape
 * @returns {string} The escaped string
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get the appropriate Accept header for a URL
 * @param {string} url - The URL
 * @returns {string} - Appropriate Accept header
 */
function getAcceptHeaderForUrl(url) {
    const extension = path.extname(url).toLowerCase();
    
    if (['.css'].includes(extension) || url.includes('.css?')) {
        return 'text/css,*/*;q=0.1';
    } else if (['.js', '.mjs'].includes(extension) || url.includes('.js?')) {
        return 'application/javascript,*/*;q=0.1';
    } else if (['.svg'].includes(extension) || url.includes('.svg')) {
        return 'image/svg+xml,*/*;q=0.8';
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(extension) || 
              url.includes('.png') || url.includes('.jpg') || url.includes('.gif') || 
              url.includes('.webp') || url.includes('.avif')) {
        return 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
    } else if (['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(extension)) {
        return 'application/font-woff2;q=1.0,application/font-woff;q=0.9,*/*;q=0.8';
    } else {
        return 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
    }
}

/**
 * Updates HTML files to reference local resources 
 * @param {string} outputDir - Directory containing HTML files
 * @param {Map<string, Object>} resourcePaths - Map of original URLs to local paths
 * @returns {Promise<void>}
 */
async function updateHtmlFiles(outputDir, resourcePaths) {
    console.log("Updating HTML files to reference local resources...");

    try {
        // Get all HTML files
        const files = await fs.readdir(outputDir);
        const htmlFiles = files.filter(file => file.endsWith('.html'));
        
        console.log(`Found ${htmlFiles.length} HTML files to update`);
        
        for (const htmlFile of htmlFiles) {
            const filePath = path.join(outputDir, htmlFile);
            console.log(`Updating resources in: ${filePath}`);
            
            // Read the file
            let content = await fs.readFile(filePath, 'utf8');
            
            // First, extract and save all file:/// links so we can restore them later
            const fileLinks = [];
            const fileLinkRegex = /(href|data-local-file)="(file:\/\/\/[^"]+)"/g;
            let match;
            while ((match = fileLinkRegex.exec(content)) !== null) {
                fileLinks.push({
                    attribute: match[1],
                    value: match[2],
                    fullMatch: match[0]
                });
            }
            
            console.log(`Preserved ${fileLinks.length} absolute file links in ${htmlFile}`);
            
            // Fix CSS and JS references with relative path patterns
            const relativeResourceRegex = /(href|src)="(\/_next\/static\/[^"]+)"/g;
            content = content.replace(relativeResourceRegex, (match, attr, resourcePath) => {
                // Check if this path is in our resource map
                const fullUrl = BASE_URL + resourcePath;
                let replacementPath = '';
                
                // Try to find matching resource in the map
                for (const [originalUrl, localInfo] of resourcePaths.entries()) {
                    if (originalUrl.includes(resourcePath) || originalUrl.endsWith(resourcePath.substring(1))) {
                        replacementPath = `./${localInfo.outputDir}/${localInfo.safeFilename}`;
                        console.log(`[HTML Resource Fix] ${attr}="${resourcePath}" -> ${attr}="${replacementPath}"`);
                        return `${attr}="${replacementPath}"`;
                    }
                }
                
                // If we can make an educated guess about CSS/JS file location based on the path pattern
                if (resourcePath.includes('/css/')) {
                    const cssFilename = resourcePath.split('/').pop();
                    const safeCssFilename = `__next_static_css_${cssFilename.replace(/[^a-z0-9.-]/gi, '_')}_${cssFilename}`;
                    replacementPath = `./css/${safeCssFilename}`;
                    console.log(`[HTML CSS Fix] ${attr}="${resourcePath}" -> ${attr}="${replacementPath}"`);
                    return `${attr}="${replacementPath}"`;
                } else if (resourcePath.includes('/js/') || resourcePath.includes('/chunks/')) {
                    const jsFilename = resourcePath.split('/').pop();
                    const safeJsFilename = `__next_static_chunks_${jsFilename.replace(/[^a-z0-9.-]/gi, '_')}_${jsFilename}`;
                    replacementPath = `./js/${safeJsFilename}`;
                    console.log(`[HTML JS Fix] ${attr}="${resourcePath}" -> ${attr}="${replacementPath}"`);
                    return `${attr}="${replacementPath}"`;
                }
                
                // If no match found, return original
                return match;
            });
            
            // Also handle data-n-href attributes which often reference CSS
            const dataNHrefRegex = /data-n-href="(\/_next\/static\/[^"]+)"/g;
            content = content.replace(dataNHrefRegex, (match, resourcePath) => {
                if (resourcePath.includes('/css/')) {
                    const cssFilename = resourcePath.split('/').pop();
                    const safeCssFilename = `__next_static_css_${cssFilename.replace(/[^a-z0-9.-]/gi, '_')}_${cssFilename}`;
                    const replacementPath = `./css/${safeCssFilename}`;
                    console.log(`[HTML data-n-href Fix] data-n-href="${resourcePath}" -> data-n-href="${replacementPath}"`);
                    return `data-n-href="${replacementPath}"`;
                }
                return match;
            });
            
            // Load with cheerio to modify resource references
            const $ = cheerio.load(content);
            
            // Process resource URLs but preserve navigation links
            let replacementsMade = 0;
            
            // Handle images, CSS, JavaScript, and other assets
            $('img[src], link[href], script[src], source[src], image[href], svg image[href], svg use[href]').each((i, el) => {
                const $el = $(el);
                const tagName = $el.get(0).tagName.toLowerCase();
                
                // Get the appropriate attribute based on tag type
                let attrName, urlValue;
                if (tagName === 'link') {
                    attrName = 'href';
                    urlValue = $el.attr('href');
                } else if (tagName === 'image' || tagName === 'use') {
                    attrName = 'href';
                    urlValue = $el.attr('href');
                } else {
                    attrName = 'src';
                    urlValue = $el.attr('src');
                }
                
                // Skip if no URL or if it's a navigation link we've already fixed
                if (!urlValue || urlValue.startsWith('file:///') || urlValue.startsWith('./css/') || urlValue.startsWith('./js/') || urlValue.startsWith('./assets/')) {
                    return;
                }
                
                // Special case for /_next/ resources that may have been missed
                if (urlValue.startsWith('/_next/')) {
                    if (urlValue.includes('/css/')) {
                        const cssFilename = urlValue.split('/').pop();
                        const safeCssFilename = `__next_static_css_${cssFilename.replace(/[^a-z0-9.-]/gi, '_')}_${cssFilename}`;
                        const replacementPath = `./css/${safeCssFilename}`;
                        console.log(`[Cheerio CSS Fix] ${attrName}="${urlValue}" -> ${attrName}="${replacementPath}"`);
                        $el.attr(attrName, replacementPath);
                        replacementsMade++;
                        return;
                    } else if (urlValue.includes('/js/') || urlValue.includes('/chunks/')) {
                        const jsFilename = urlValue.split('/').pop();
                        const safeJsFilename = `__next_static_chunks_${jsFilename.replace(/[^a-z0-9.-]/gi, '_')}_${jsFilename}`;
                        const replacementPath = `./js/${safeJsFilename}`;
                        console.log(`[Cheerio JS Fix] ${attrName}="${urlValue}" -> ${attrName}="${replacementPath}"`);
                        $el.attr(attrName, replacementPath);
                        replacementsMade++;
                        return;
                    }
                }
                
                // Try to find matching resource
                for (const [originalUrl, localInfo] of resourcePaths.entries()) {
                    if (urlValue === originalUrl || urlValue.includes(originalUrl)) {
                        const resourcePath = `./${localInfo.outputDir}/${localInfo.safeFilename}`;
                        console.log(`[Resource Replace] ${attrName}="${urlValue}" -> ${attrName}="${resourcePath}"`);
                        $el.attr(attrName, resourcePath);
                        replacementsMade++;
                        break;
                    }
                }
            });
            
            // Handle CSS background-image and other styles that might reference external resources
            $('[style]').each((i, el) => {
                const style = $(el).attr('style');
                if (!style || !style.includes('url(')) return;
                
                // Extract URLs from style
                let newStyle = style;
                const urlRegex = /url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/g;
                let match;
                
                while ((match = urlRegex.exec(style)) !== null) {
                    const originalUrl = match[1];
                    
                    // Try to find matching resource
                    for (const [resourceUrl, localInfo] of resourcePaths.entries()) {
                        if (originalUrl === resourceUrl || originalUrl.includes(resourceUrl)) {
                            const resourcePath = `./${localInfo.outputDir}/${localInfo.safeFilename}`;
                            const newUrlPart = `url('${resourcePath}')`;
                            newStyle = newStyle.replace(match[0], newUrlPart);
                            console.log(`[Style Replace] url(${originalUrl}) -> ${newUrlPart}`);
                            replacementsMade++;
                            break;
                        }
                    }
                }
                
                if (newStyle !== style) {
                    $(el).attr('style', newStyle);
                }
            });
            
            //console.log(`Made ${replacementsMade} resource replacements in ${htmlFile}`);
            
            // Get the modified content
            let modifiedContent = $.html();
            
            // Restore all file:/// links that might have been altered by Cheerio
            for (const link of fileLinks) {
                const cheerioPattern = new RegExp(`${link.attribute}="[^"]*"`, 'g');
                const originalAttrValue = `${link.attribute}="${link.value}"`;
                
                // Look for any occurrences where Cheerio might have modified our file:/// links
                if (!modifiedContent.includes(originalAttrValue)) {
                    console.log(`Restoring ${link.attribute} with file:/// URL: ${link.value}`);
                    
                    // The id attribute helps us locate the element to fix
                    if (link.attribute === 'data-local-file') {
                        // For data-local-file, we need to extract the ID
                        const idMatch = /id="([^"]+)"[^>]*data-local-file="[^"]*"/g.exec(modifiedContent);
                        if (idMatch) {
                            const idValue = idMatch[1];
                            const idPattern = new RegExp(`id="${idValue}"[^>]*data-local-file="[^"]*"`, 'g');
                            modifiedContent = modifiedContent.replace(idPattern, `id="${idValue}" data-local-file="${link.value}"`);
                        }
                    } else {
                        // For href, use a more specific pattern to ensure we only replace navigation links
                        const hrefPattern = new RegExp(`<a[^>]*href="[^"]*"[^>]*>`, 'g');
                        modifiedContent = modifiedContent.replace(hrefPattern, (match) => {
                            if (match.includes(`href="${link.value.replace(/\//g, '\\/')}"`)) {
                                return match; // Already correct
                            }
                            if (match.includes('href="/')) {
                                // This is a navigation link that needs to be fixed
                                const pathMatch = /href="(\/[^"]+)"/g.exec(match);
                                if (pathMatch && pathMatch[1]) {
                                    const path = pathMatch[1];
                                    // Only replace if it's for the same path
                                    if (link.value.includes(path.replace(/\//g, '-'))) {
                                        return match.replace(`href="${path}"`, `href="${link.value}"`);
                                    }
                                }
                            }
                            return match;
                        });
                    }
                }
            }
            
            // Save the modified content
            await fs.writeFile(filePath, modifiedContent, 'utf8');
        }
        
        console.log("Finished updating HTML files with resource references");
    } catch (error) {
        console.error("Error updating HTML files:", error);
    }
}

// Process command line arguments
function processArgs() {
    const args = process.argv.slice(2);
    let maxPages = MAX_PAGES;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--limit' || args[i] === '-l') {
            if (i + 1 < args.length) {
                const limit = parseInt(args[i + 1], 10);
                if (!isNaN(limit)) {
                    maxPages = limit;
                    console.log(`Page limit set to: ${maxPages}`);
                }
                i++; // Skip the next argument
            }
        }
    }

    return { maxPages };
}

// Main execution function
async function main() {
    // Process command line arguments
    const maxPages = 5
    
    // Ensure all output directories exist
    const outputDirs = {
        html: path.resolve(__dirname, OUTPUT_DIR),
        css: path.resolve(__dirname, OUTPUT_DIR, CSS_DIR),
        js: path.resolve(__dirname, OUTPUT_DIR, JS_DIR),
        assets: path.resolve(__dirname, OUTPUT_DIR, ASSETS_DIR)
    };
    
    for (const dir of Object.values(outputDirs)) {
        await ensureOutputDir(dir);
    }
    
    // Set to track all resources and their paths
    const resourcesToDownload = new Set();
    const resourcePaths = new Map();
    
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
            await processPage(page, currentPath, outputDirs, processedPaths, pathsToProcess, resourcesToDownload, resourcePaths);
            processedCount++;
            
            // Show progress
            console.log(`\nProgress: ${processedCount}/${maxPages < 0 ? '∞' : maxPages} pages processed, ${pathsToProcess.size} pages in queue\n`);
        }
        
        console.log("\nFinished processing pages.");
        console.log(`Processed ${processedCount} pages out of ${maxPages < 0 ? 'unlimited' : maxPages}.`);
        console.log(`Found ${resourcesToDownload.size} resources to download.`);
        
    } finally {
        // Close browser after all pages are processed
        await browser.close();
    }
    
    // Download all resources with axios after browser is closed
    await downloadAllResources(resourcesToDownload, resourcePaths, outputDirs);
    
    // Update HTML files to reference local resources correctly
    await updateHtmlFiles(path.resolve(__dirname, OUTPUT_DIR), resourcePaths);

    console.log("\nScraping complete.");
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
    console.error("\nAn unexpected error occurred during scraping:", error);
    process.exit(1);
});