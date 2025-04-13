const fs = require('fs/promises');
const path = require('path');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { URL } = require('url');

// Import the JSON extractor module
const jsonExtractor = require('./jsonExtractor');

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
const JSON_DIR = path.join(OUTPUT_DIR, 'json');
const WAIT_TIME = 3000; // Time to wait for page to fully load in ms
const MAX_PAGES = -1; // Maximum number of pages to process (set to -1 for unlimited)
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
        
        // Special handling for SVG files
        if (url.toLowerCase().includes('.svg') || pathname.toLowerCase().endsWith('.svg')) {
            // Check for various template patterns in the URL
            if (url.includes('${t}') || url.includes('${r') || url.includes('$\\{t\\}')) {
                // Extract the variable name from patterns with template literals
                if (url.includes('lucide/${t}.svg') || url.includes('lucide/$\\{t\\}.svg')) {
                    return "${t}.svg";
                }
                
                // Handle other template patterns
                if (url.includes('brands/${t}.svg') || url.includes('brands/$\\{t\\}.svg')) {
                    return "${t}.svg";
                }
                
                // Handle the pattern with r??\"regular\"
                if (url.includes('${r??\"regular\"}/${t}') || url.includes('$\\{r\\?\\?\\\"regular\\\"\\}/$\\{t\\}')) {
                    return "${t}.svg";
                }
                
                // Default case for template variables
                return "${t}.svg";
            }
            
            // Check for placeholder template variables like ${t}
            const templateMatch = url.match(/\/([^\/]+)\/${?t}?\.svg/i) || url.match(/\/([^\/]+)\$\{t\}\.svg/i);
            if (templateMatch) {
                return "${t}.svg";
            }
            
            // First check for mintlify SVG patterns specifically
            if (hostname.includes('mintlify') || url.includes('mintlify')) {
                // Extract just the SVG name from patterns like mintlify-b-cdn-net/v6-6-0/regular/address-card.svg
                const segments = pathname.split('/').filter(Boolean);
                const lastSegment = segments[segments.length - 1];
                
                if (lastSegment) {
                    // Clean up the segment, removing query params
                    const cleanSegment = lastSegment.split('?')[0].split('#')[0];
                    
                    // If it's a direct SVG file
                    if (cleanSegment.toLowerCase().endsWith('.svg')) {
                        return cleanSegment.toLowerCase();
                    }
                    
                    // If it doesn't have an extension, add .svg
                    if (!cleanSegment.includes('.')) {
                        return `${cleanSegment.toLowerCase()}.svg`;
                    }
                    
                    return cleanSegment.toLowerCase();
                }
            }
            
            // Extract the base name for SVG files (removing any query params)
            const svgName = path.basename(pathname).split('?')[0].split('#')[0];
            if (svgName && svgName !== '/' && svgName.toLowerCase().endsWith('.svg')) {
                return svgName.toLowerCase(); // Return just the SVG filename
            }
            
            // If we can't extract the name directly, try to get it from the path
            const segments = pathname.split('/').filter(Boolean);
            let lastSegment = segments[segments.length - 1];
            
            // Clean up the segment, removing query params
            if (lastSegment) {
                lastSegment = lastSegment.split('?')[0].split('#')[0];
                
                if (lastSegment.toLowerCase().endsWith('.svg')) {
                    return lastSegment.toLowerCase();
                }
            }
            
            // For SVGs in URL paths like /v6.6.0/lucide/search.svg, extract just the last part
            if (segments.length > 0) {
                const lastPathComponent = segments[segments.length - 1].split('?')[0].split('#')[0];
                if (lastPathComponent) {
                    // If it doesn't have an extension, add .svg
                    if (!lastPathComponent.includes('.')) {
                        return `${lastPathComponent.toLowerCase()}.svg`;
                    }
                    return lastPathComponent.toLowerCase();
                }
            }
        }
        
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
            
            // Extract SVG images from mask-image properties (including those with encoded quotes)
            document.querySelectorAll('[style*="mask-image"]').forEach(el => {
                const styleAttr = el.getAttribute('style');
                if (styleAttr) {
                    // Handle both regular quotes and HTML entity quotes (&quot;)
                    const maskUrlRegex = /mask-image:\s*url\((?:['"]|&quot;)([^'"&]*)(?:['"]|&quot;)\)/i;
                    const match = maskUrlRegex.exec(styleAttr);
                    if (match && match[1]) {
                        const svgUrl = match[1];
                        const absUrl = toAbsoluteUrl(svgUrl);
                        if (absUrl) {
                            items.push(absUrl);
                        }
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
        
        // Find all Next.js CSS files
        const nextCssPattern = /_next\/static\/css\/[^"']+\.css/g;
        let cssMatch;
        while ((cssMatch = nextCssPattern.exec(pageHtml)) !== null) {
            const cssPath = cssMatch[0];
            const fullCssUrl = BASE_URL + '/' + cssPath.replace(/^\//, '');
            resources.push(fullCssUrl);
        }
        
        // Find all Next.js JavaScript files
        const nextJsPatterns = [
            /_next\/static\/chunks\/[^"']+\.js/g,
            /_next\/static\/[^"'\/]+\/[^"']+\.js/g, // For build manifest and SSG manifest
            /_next\/static\/[^"']+\/_buildManifest\.js/g,
            /_next\/static\/[^"']+\/_ssgManifest\.js/g
        ];
        
        for (const pattern of nextJsPatterns) {
            let jsMatch;
            while ((jsMatch = pattern.exec(pageHtml)) !== null) {
                const jsPath = jsMatch[0];
                const fullJsUrl = BASE_URL + '/' + jsPath.replace(/^\//, '');
                resources.push(fullJsUrl);
            }
        }
        
        // Extract SVG files from mask-image in the raw HTML (to handle &quot; entity encoding)
        const maskImagePattern = /mask-image:\s*url\(&quot;([^&]+)&quot;\)/g;
        let svgMatch;
        while ((svgMatch = maskImagePattern.exec(pageHtml)) !== null) {
            const svgUrl = svgMatch[1];
            if (svgUrl && svgUrl.toLowerCase().endsWith('.svg')) {
                resources.push(svgUrl);
            }
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

/**
 * Process HTML files to replace all resource URLs with local paths
 * @param {Object} collectedData - The data collected from all pages
 * @returns {Promise<void>}
 */
async function processHtmlFiles(collectedData) {
    console.log("\n--- Starting HTML processing phase ---\n");
    
    // Create a mapping of remote URLs to local file paths for all resources
    const resourceUrlMap = new Map();
    
    // Build the mapping from all pages for all resource types
    for (const page of collectedData.pages) {
        for (const resourceType of ['css', 'js', 'images', 'fonts', 'other']) {
            for (const resource of page.resources[resourceType]) {
                if (resource.downloaded && resource.localPath) {
                    resourceUrlMap.set(resource.url, resource.localPath);
                    
                    // Also add relative URL paths
                    const relativeUrl = resource.url.replace(BASE_URL, '');
                    if (relativeUrl.startsWith('/')) {
                        resourceUrlMap.set(relativeUrl, resource.localPath);
                    }
                }
            }
        }
    }
    
    console.log(`Found ${resourceUrlMap.size} resources to replace in HTML files`);
    
    // Process each HTML file
    for (const page of collectedData.pages) {
        if (!page.htmlFile) continue;
        
        const htmlFilePath = path.join(OUTPUT_DIR, page.htmlFile);
        console.log(`Processing HTML file: ${htmlFilePath}`);
        
        try {
            // Read the HTML file
            let htmlContent = await fs.readFile(htmlFilePath, 'utf8');
            let replacementCounts = {
                css: 0,
                js: 0,
                images: 0,
                fonts: 0,
                other: 0,
                svgToImg: 0
            };
            
            // First, handle SVG elements containing mintlify in style attribute or mask-image URLs
            // Find and replace all SVG elements with mask-image properties
            // This approach looks for any SVG with style containing mask-image regardless of URL format
            const svgRegex = /<svg[^>]*style=["']([^"']*mask-image[^"']*)["'][^>]*>[\s\S]*?<\/svg>/gi;
            let svgMatch;
            
            // Store all replacements to apply at once
            const svgReplacements = [];
            
            // // First pass - identify all SVGs with mask-image
            // while ((svgMatch = svgRegex.exec(htmlContent)) !== null) {
            //     const fullSvgElement = svgMatch[0];
            //     const stylesAttribute = svgMatch[1];
                
            //     // Check if it contains mintlify in the mask-image URL
            //     if (stylesAttribute.includes('mintlify')) {
            //         // Extract all attributes from the SVG element
            //         const classMatch = /class=["']([^"']*)["']/i.exec(fullSvgElement);
            //         const classAttr = classMatch ? classMatch[1] : '';
                    
            //         // Extract other style properties we want to keep
            //         const stylesWithoutMask = stylesAttribute.replace(/(-webkit-)?mask-image:[^;]+;?/g, '')
            //             .replace(/(-webkit-)?mask-repeat:[^;]+;?/g, '')
            //             .replace(/(-webkit-)?mask-position:[^;]+;?/g, '');
                    
            //         // Create a direct image element instead
            //         // Don't use the local file path - keep the original asset path
            //         const imgElement = `<img class="${classAttr}" style="${stylesWithoutMask}" alt="" src="${extractAssetPath(stylesAttribute)}" />`;
                    
            //         // Add to replacements list
            //         svgReplacements.push({
            //             original: fullSvgElement,
            //             replacement: imgElement
            //         });
            //         replacementCounts.svgToImg++;
            //     }
            // }
            
            // Helper function to extract the asset path from style attribute
            function extractAssetPath(style) {
                // Look for the mask-image URL pattern in the style
                const maskMatch = /mask-image:\s*url\(['"]?(.*?)['"]?\)/i.exec(style);
                if (maskMatch && maskMatch[1]) {
                    return maskMatch[1];
                }
                // Fallback to webkit version if regular mask-image not found
                const webkitMatch = /-webkit-mask-image:\s*url\(['"]?(.*?)['"]?\)/i.exec(style);
                if (webkitMatch && webkitMatch[1]) {
                    return webkitMatch[1];
                }
                return '';
            }
            
            // Apply SVG -> IMG replacements
            for (const replacement of svgReplacements) {
                htmlContent = htmlContent.replace(replacement.original, replacement.replacement);
            }
            
            // Replace each resource URL with its local path
            for (const [remoteUrl, localPath] of resourceUrlMap.entries()) {
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
                
                // Create various forms of the URL to replace
                const urlVariations = [
                    remoteUrl,
                    remoteUrl.replace(BASE_URL, ''),
                    `"${remoteUrl}"`,
                    `'${remoteUrl}'`,
                    `"${remoteUrl.replace(BASE_URL, '')}"`,
                    `'${remoteUrl.replace(BASE_URL, '')}'`,
                    `&quot;${remoteUrl}&quot;`,
                    `&quot;${remoteUrl.replace(BASE_URL, '')}&quot;`
                ];
                
                // Local path should use forward slashes for URLs in HTML
                const localUrl = localPath.replace(/\\/g, '/');
                
                // Replace all variations
                for (const urlVariation of urlVariations) {
                    if (htmlContent.includes(urlVariation)) {
                        htmlContent = htmlContent.split(urlVariation).join(localUrl);
                        replacementCounts[resourceType]++;
                    }
                }
                
                // Get the URL path relative to the base URL
                const relativeUrlPath = remoteUrl.replace(BASE_URL, '');
                
                if (isCSS) {
                    // CSS-specific replacements
                    
                    // Replace URL in special Next.js patterns for CSS
                    const cssNextJsPattern = new RegExp(`(href|data-href|data-n-href)=["']${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                    htmlContent = htmlContent.replace(cssNextJsPattern, `$1="${localUrl}"`);
                    
                    // Handle preload links for CSS
                    const cssPreloadPattern = new RegExp(`<link rel="preload" href="${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}" as="style">`, 'g');
                    htmlContent = htmlContent.replace(cssPreloadPattern, `<link rel="preload" href="${localUrl}" as="style">`);
                    
                    if (relativeUrlPath.startsWith('/')) {
                        // Handle relative URLs in Next.js patterns for CSS
                        const relativeCssNextJsPattern = new RegExp(`(href|data-href|data-n-href)=["']${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                        htmlContent = htmlContent.replace(relativeCssNextJsPattern, `$1="${localUrl}"`);
                        
                        const relativeCssPreloadPattern = new RegExp(`<link rel="preload" href="${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}" as="style">`, 'g');
                        htmlContent = htmlContent.replace(relativeCssPreloadPattern, `<link rel="preload" href="${localUrl}" as="style">`);
                        
                        // Handle the specific pattern for CSS
                        const nextJsCssPattern = new RegExp(`href="${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}" as="style"`, 'g');
                        htmlContent = htmlContent.replace(nextJsCssPattern, `href="${localUrl}" as="style"`);
                        
                        // Handle style data-n-href attribute
                        const styleDataHrefPattern = new RegExp(`data-n-href="${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}"`, 'g');
                        htmlContent = htmlContent.replace(styleDataHrefPattern, `data-n-href="${localUrl}"`);
                        
                        // Handle noscript content for CSS
                        const noscriptPattern = new RegExp(`<noscript[^>]*><link[^>]*href="${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}"[^>]*></noscript>`, 'g');
                        htmlContent = htmlContent.replace(noscriptPattern, (match) => {
                            return match.replace(relativeUrlPath, localUrl);
                        });
                    }
                }
                
                if (isJS) {
                    // JS-specific replacements
                    
                    // Replace URL in script src attributes
                    const jsScriptPattern = new RegExp(`src=["']${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                    htmlContent = htmlContent.replace(jsScriptPattern, `src="${localUrl}"`);
                    
                    // Handle preload links for JS
                    const jsPreloadPattern = new RegExp(`<link rel="preload" href="${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}" as="script">`, 'g');
                    htmlContent = htmlContent.replace(jsPreloadPattern, `<link rel="preload" href="${localUrl}" as="script">`);
                    
                    if (relativeUrlPath.startsWith('/')) {
                        // Handle relative URLs in script tags
                        const relativeJsScriptPattern = new RegExp(`src=["']${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                        htmlContent = htmlContent.replace(relativeJsScriptPattern, `src="${localUrl}"`);
                        
                        // Handle relative preload links for JS
                        const relativeJsPreloadPattern = new RegExp(`<link rel="preload" href="${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}" as="script">`, 'g');
                        htmlContent = htmlContent.replace(relativeJsPreloadPattern, `<link rel="preload" href="${localUrl}" as="script">`);
                    }
                }
                
                if (isImage) {
                    // Image-specific replacements
                    
                    // Replace in img src attributes
                    const imgSrcPattern = new RegExp(`src=["']${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                    htmlContent = htmlContent.replace(imgSrcPattern, `src="${localUrl}"`);
                    
                    // Replace in srcset attributes
                    const srcsetPattern = new RegExp(`srcset=["'][^"']*${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}[^"']*["']`, 'g');
                    if (srcsetPattern.test(htmlContent)) {
                        htmlContent = htmlContent.replace(srcsetPattern, (match) => {
                            return match.replace(remoteUrl, localUrl);
                        });
                    }
                    
                    // Replace in meta image tags
                    const metaPattern = new RegExp(`content=["']${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                    htmlContent = htmlContent.replace(metaPattern, `content="${localUrl}"`);
                    
                    // Replace in inline style background-image
                    const inlineStylePattern = new RegExp(`background-image:\\s*url\\(['"]?${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]?\\)`, 'g');
                    htmlContent = htmlContent.replace(inlineStylePattern, `background-image: url('${localUrl}')`);
                    
                    if (relativeUrlPath.startsWith('/')) {
                        // Handle relative URLs in image tags
                        const relativeImgSrcPattern = new RegExp(`src=["']${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                        htmlContent = htmlContent.replace(relativeImgSrcPattern, `src="${localUrl}"`);
                        
                        // Handle relative URLs in srcset
                        const relativeSrcsetPattern = new RegExp(`srcset=["'][^"']*${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}[^"']*["']`, 'g');
                        if (relativeSrcsetPattern.test(htmlContent)) {
                            htmlContent = htmlContent.replace(relativeSrcsetPattern, (match) => {
                                return match.replace(relativeUrlPath, localUrl);
                            });
                        }
                        
                        // Handle relative URLs in meta tags
                        const relativeMetaPattern = new RegExp(`content=["']${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                        htmlContent = htmlContent.replace(relativeMetaPattern, `content="${localUrl}"`);
                        
                        // Handle relative URLs in inline styles
                        const relativeInlineStylePattern = new RegExp(`background-image:\\s*url\\(['"]?${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]?\\)`, 'g');
                        htmlContent = htmlContent.replace(relativeInlineStylePattern, `background-image: url('${localUrl}')`);
                    }
                }
                
                if (isFont) {
                    // Font-specific replacements
                    
                    // Replace in @font-face declarations that might be inline
                    const fontFacePattern = new RegExp(`src:\\s*url\\(['"]?${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]?\\)`, 'g');
                    htmlContent = htmlContent.replace(fontFacePattern, `src: url('${localUrl}')`);
                    
                    if (relativeUrlPath.startsWith('/')) {
                        // Handle relative URLs in font-face
                        const relativeFontFacePattern = new RegExp(`src:\\s*url\\(['"]?${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]?\\)`, 'g');
                        htmlContent = htmlContent.replace(relativeFontFacePattern, `src: url('${localUrl}')`);
                    }
                }
                
                // Handle any other type of resource
                if (resourceType === 'other') {
                    // Generic replacements for other resource types
                    
                    // Handle object data attributes
                    const objectPattern = new RegExp(`data=["']${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                    htmlContent = htmlContent.replace(objectPattern, `data="${localUrl}"`);
                    
                    // Handle embed src attributes
                    const embedPattern = new RegExp(`src=["']${remoteUrl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                    htmlContent = htmlContent.replace(embedPattern, `src="${localUrl}"`);
                    
                    if (relativeUrlPath.startsWith('/')) {
                        // Handle relative URLs for other resources
                        const relativeObjectPattern = new RegExp(`data=["']${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                        htmlContent = htmlContent.replace(relativeObjectPattern, `data="${localUrl}"`);
                        
                        const relativeEmbedPattern = new RegExp(`src=["']${relativeUrlPath.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`, 'g');
                        htmlContent = htmlContent.replace(relativeEmbedPattern, `src="${localUrl}"`);
                    }
                }
            }
            
            // Save the modified HTML file
            await fs.writeFile(htmlFilePath, htmlContent);
            console.log(`Replaced resources in ${htmlFilePath}: CSS (${replacementCounts.css}), JS (${replacementCounts.js}), Images (${replacementCounts.images}), Fonts (${replacementCounts.fonts}), Other (${replacementCounts.other}), SVG→IMG (${replacementCounts.svgToImg})`);
            
            // Update the page data to indicate it was processed
            page.htmlProcessed = true;
            page.replacementCounts = replacementCounts;
            
        } catch (error) {
            console.error(`Error processing HTML file ${htmlFilePath}: ${error.message}`);
            page.htmlProcessingError = error.message;
        }
    }
    
    console.log("\n--- HTML processing phase complete ---\n");
}

/**
 * Process CSS files to replace @import URLs with local paths
 * @param {Object} collectedData - The data collected from all pages
 * @returns {Promise<void>}
 */
async function processCssFiles(collectedData) {
    console.log("\n--- Starting CSS processing phase ---\n");
    
    // Create a mapping of remote URLs to local file paths for all CSS resources
    const cssUrlMap = new Map();
    
    // Build the mapping from all pages
    for (const page of collectedData.pages) {
        for (const resource of page.resources.css) {
            if (resource.downloaded && resource.localPath) {
                cssUrlMap.set(resource.url, resource.localPath);
                
                // Also add relative URL paths
                const relativeUrl = resource.url.replace(BASE_URL, '');
                if (relativeUrl.startsWith('/')) {
                    cssUrlMap.set(relativeUrl, resource.localPath);
                }
            }
        }
    }
    
    console.log(`Processing ${cssUrlMap.size} CSS files for @import statements`);
    
    // Process each CSS file
    let processedCount = 0;
    
    for (const [remoteUrl, localPath] of cssUrlMap.entries()) {
        const cssFilePath = path.join(OUTPUT_DIR, localPath);
        
        try {
            // Skip if the file doesn't exist or if it's not a full URL (to avoid duplicates)
            if (!remoteUrl.startsWith('http') || !(await fs.access(cssFilePath).then(() => true).catch(() => false))) {
                continue;
            }
            
            // Read the CSS file
            let cssContent = await fs.readFile(cssFilePath, 'utf8');
            let replacementsMade = 0;
            
            // Find all @import statements
            const importRegex = /@import\s+(?:url\(['"]?(.*?)['"]?\)|['"]([^'"]+)['"]);/g;
            
            // Process each @import statement
            let match;
            while ((match = importRegex.exec(cssContent)) !== null) {
                const importUrl = match[1] || match[2];
                if (!importUrl) continue;
                
                // Resolve relative URLs
                let fullImportUrl;
                if (importUrl.startsWith('http')) {
                    fullImportUrl = importUrl;
                } else if (importUrl.startsWith('/')) {
                    fullImportUrl = BASE_URL + importUrl;
                } else {
                    // Relative to the CSS file
                    const baseUrlObj = new URL(remoteUrl);
                    const basePath = baseUrlObj.pathname.substring(0, baseUrlObj.pathname.lastIndexOf('/') + 1);
                    fullImportUrl = `${baseUrlObj.origin}${basePath}${importUrl}`;
                }
                
                // Check if we have a local version of this imported CSS
                const localImportPath = cssUrlMap.get(fullImportUrl);
                if (localImportPath) {
                    // Replace with local path (using forward slashes for URLs)
                    const localImportUrl = localImportPath.replace(/\\/g, '/');
                    
                    // Create replacement pattern based on the original match
                    let replacement;
                    if (match[1]) { // url() pattern
                        replacement = `@import url('${localImportUrl}');`;
                    } else { // direct string pattern
                        replacement = `@import '${localImportUrl}';`;
                    }
                    
                    // Replace this specific @import
                    cssContent = cssContent.replace(match[0], replacement);
                    replacementsMade++;
                }
            }
            
            // Replace url() references in the CSS - for images, fonts, etc.
            const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
            while ((match = urlRegex.exec(cssContent)) !== null) {
                const urlPath = match[1];
                if (!urlPath || urlPath.startsWith('data:')) continue;
                
                // Resolve the URL
                let fullUrl;
                if (urlPath.startsWith('http')) {
                    fullUrl = urlPath;
                } else if (urlPath.startsWith('/')) {
                    fullUrl = BASE_URL + urlPath;
                } else {
                    // Relative to the CSS file
                    const baseUrlObj = new URL(remoteUrl);
                    const basePath = baseUrlObj.pathname.substring(0, baseUrlObj.pathname.lastIndexOf('/') + 1);
                    fullUrl = `${baseUrlObj.origin}${basePath}${urlPath}`;
                }
                
                // Check for local resources across all resource types
                let localResourcePath = null;
                for (const page of collectedData.pages) {
                    for (const resourceType of ['images', 'fonts', 'other']) {
                        const resource = page.resources[resourceType].find(r => r.url === fullUrl && r.downloaded);
                        if (resource && resource.localPath) {
                            localResourcePath = resource.localPath;
                            break;
                        }
                    }
                    if (localResourcePath) break;
                }
                
                // Replace with local path if found
                if (localResourcePath) {
                    const localUrl = localResourcePath.replace(/\\/g, '/');
                    const replacement = `url('${localUrl}')`;
                    cssContent = cssContent.replace(match[0], replacement);
                        replacementsMade++;
                }
            }
            
            // Save the file if changes were made
            if (replacementsMade > 0) {
                await fs.writeFile(cssFilePath, cssContent);
                console.log(`Replaced ${replacementsMade} URLs in CSS file: ${cssFilePath}`);
                processedCount++;
            }
            
        } catch (error) {
            console.error(`Error processing CSS file ${cssFilePath}: ${error.message}`);
        }
    }
    
    console.log(`\nProcessed ${processedCount} CSS files with URL replacements`);
    console.log("\n--- CSS processing phase complete ---\n");
}

/**
 * Process JS files to replace URLs with local paths
 * @param {Object} collectedData - The data collected from all pages
 * @returns {Promise<void>}
 */
async function processJsFiles(collectedData) {
    console.log("\n--- Starting JS processing phase ---\n");
    
    // Create a mapping of remote URLs to local file paths for all resources
    const resourceUrlMap = new Map();
    
    // Build the mapping from all pages for all resource types
    for (const page of collectedData.pages) {
        for (const resourceType of ['js', 'css', 'images', 'fonts', 'other']) {
            for (const resource of page.resources[resourceType]) {
                if (resource.downloaded && resource.localPath) {
                    resourceUrlMap.set(resource.url, resource.localPath);
                    
                    // Also add relative URL paths
                    const relativeUrl = resource.url.replace(BASE_URL, '');
                    if (relativeUrl.startsWith('/')) {
                        resourceUrlMap.set(relativeUrl, resource.localPath);
                    }
                }
            }
        }
    }
    
    // Create a mapping specifically for JS files
    const jsUrlMap = new Map();
    for (const [url, localPath] of resourceUrlMap.entries()) {
        if (url.toLowerCase().includes('.js') || categorizeResource(url) === 'js') {
            jsUrlMap.set(url, localPath);
        }
    }
    
    console.log(`Processing ${jsUrlMap.size} JS files for URL references`);
    
    // Process each JS file
    let processedCount = 0;
    
    for (const [remoteUrl, localPath] of jsUrlMap.entries()) {
        const jsFilePath = path.join(OUTPUT_DIR, localPath);
        
        try {
            // Skip if the file doesn't exist or if it's not a full URL (to avoid duplicates)
            if (!remoteUrl.startsWith('http') || !(await fs.access(jsFilePath).then(() => true).catch(() => false))) {
                continue;
            }
            
            // Read the JS file
            let jsContent = await fs.readFile(jsFilePath, 'utf8');
            let replacementsMade = 0;
            
            // Look for various URL patterns in the JS files
            
            // 1. Dynamic import() calls
            const importRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
            let match;
            while ((match = importRegex.exec(jsContent)) !== null) {
                const importPath = match[1];
                
                // Resolve relative URLs
                let fullImportUrl;
                if (importPath.startsWith('http')) {
                    fullImportUrl = importPath;
                } else if (importPath.startsWith('/')) {
                    fullImportUrl = BASE_URL + importPath;
                    } else {
                    // Relative to the JS file
                    const baseUrlObj = new URL(remoteUrl);
                    const basePath = baseUrlObj.pathname.substring(0, baseUrlObj.pathname.lastIndexOf('/') + 1);
                    fullImportUrl = `${baseUrlObj.origin}${basePath}${importPath}`;
                }
                
                // Check if we have a local version of this resource
                let localImportPath = resourceUrlMap.get(fullImportUrl);
                
                // If not found, try adding .js extension
                if (!localImportPath && !fullImportUrl.endsWith('.js')) {
                    localImportPath = resourceUrlMap.get(fullImportUrl + '.js');
                }
                
                // Replace with local path if found
                if (localImportPath) {
                    const localImportUrl = localImportPath.replace(/\\/g, '/');
                    jsContent = jsContent.replace(
                        `import("${importPath}")`, 
                        `import("./${localImportUrl}")`
                    );
                    replacementsMade++;
                }
            }
            
            // 2. URL references in strings
            const urlPatterns = [
                // Direct URL references
                /(["'])(\/_next\/static\/[^'"]+)(["'])/g,
                // Full URL references
                new RegExp(`(["'])(${BASE_URL.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}[^'"]+)(["'])`, 'g')
            ];
            
            for (const pattern of urlPatterns) {
                while ((match = pattern.exec(jsContent)) !== null) {
                    const urlPath = match[2];
                    let fullUrl = urlPath;
                    
                    // If it's a relative path, convert to full URL
                    if (urlPath.startsWith('/')) {
                        fullUrl = BASE_URL + urlPath;
                    }
                    
                    // Check for a local version
                    const localResourcePath = resourceUrlMap.get(fullUrl);
                    if (localResourcePath) {
                        const localUrl = localResourcePath.replace(/\\/g, '/');
                        const replacement = `${match[1]}${localUrl}${match[3]}`;
                        jsContent = jsContent.replace(match[0], replacement);
                        replacementsMade++;
                    }
                }
            }
            
            // 3. Replace chunk loading paths specific to Next.js
            const chunkLoaderRegex = /path:\s*["'](\/[^'"]+)["']/g;
            while ((match = chunkLoaderRegex.exec(jsContent)) !== null) {
                const urlPath = match[1];
                const fullUrl = BASE_URL + urlPath;
                
                // Check for a local version
                const localResourcePath = resourceUrlMap.get(fullUrl);
                if (localResourcePath) {
                    const localUrl = localResourcePath.replace(/\\/g, '/');
                    jsContent = jsContent.replace(
                        `path:"${urlPath}"`, 
                        `path:"${localUrl}"`
                    );
                    replacementsMade++;
                }
            }
            
            // Save the file if changes were made
            if (replacementsMade > 0) {
                await fs.writeFile(jsFilePath, jsContent);
                console.log(`Replaced ${replacementsMade} URLs in JS file: ${jsFilePath}`);
                processedCount++;
            }
            
        } catch (error) {
            console.error(`Error processing JS file ${jsFilePath}: ${error.message}`);
        }
    }
    
    console.log(`\nProcessed ${processedCount} JS files with URL replacements`);
    console.log("\n--- JS processing phase complete ---\n");
}

/**
 * Process JS files to handle specific edge cases and patterns
 * @param {Object} collectedData - The data collected from all pages
 * @returns {Promise<void>}
 */
async function processJsFileEdgeCases(collectedData) {
    console.log("\n--- Starting JS edge case processing phase ---\n");
    
    // Create a mapping specifically for JS files
    const jsResources = [];
    
    // Collect all JS resources
    for (const page of collectedData.pages) {
        for (const resource of page.resources.js) {
            if (resource.downloaded && resource.localPath) {
                jsResources.push(resource);
            }
        }
    }
    
    console.log(`Processing ${jsResources.length} JS files for specific string replacements`);
    
    // Process each JS file
    let processedCount = 0;
    
    for (const resource of jsResources) {
        const jsFilePath = path.join(OUTPUT_DIR, resource.localPath);
        
        try {
            // Skip if the file doesn't exist
            if (!(await fs.access(jsFilePath).then(() => true).catch(() => false))) {
                continue;
            }
            
            // Read the JS file
            let jsContent = await fs.readFile(jsFilePath, 'utf8');
            let replacementsMade = 0;
            
            // 1. Replace "pdf"===d with "pdf"==="pdf"
            const pdfCheck = /"pdf"===d/g;
            const pdfReplacements = (jsContent.match(pdfCheck) || []).length;
            if (pdfReplacements > 0) {
                jsContent = jsContent.replace(pdfCheck, '"pdf"==="pdf"');
                replacementsMade += pdfReplacements;
            }
            
            // 2. Replace Mintlify CDN URLs with local paths
            const replacements = [
                {
                    pattern: /https:\/\/mintlify\.b-cdn\.net\/v6\.6\.0\/lucide\/\$\{t\}\.svg/g,
                    replacement: "assets/${t}.svg"
                },
                {
                    pattern: /https:\/\/mintlify\.b-cdn\.net\/v6\.6\.0\/\$\{r\?\?\"regular\"\}\/\$\{t\}/g,
                    replacement: "assets/${t}"
                },
                {
                    pattern: /https:\/\/mintlify\.b-cdn\.net\/v6\.6\.0\/brands\/\$\{t\}\.svg/g,
                    replacement: "assets/${t}.svg"
                },
                {
                    pattern: /backgroundColor:"transparent"/g,
                    replacement: 'backgroundColor:\"white\",borderRadius:3,padding:"1px"'
                }
            ];
            
            for (const { pattern, replacement } of replacements) {
                const count = (jsContent.match(pattern) || []).length;
                if (count > 0) {
                    jsContent = jsContent.replace(pattern, replacement);
                    replacementsMade += count;
                }
            }
            
            // Save the file if changes were made
            if (replacementsMade > 0) {
                await fs.writeFile(jsFilePath, jsContent);
                console.log(`Applied ${replacementsMade} edge case replacements in JS file: ${jsFilePath}`);
                processedCount++;
            }
            
        } catch (error) {
            console.error(`Error processing JS file edge cases in ${jsFilePath}: ${error.message}`);
        }
    }
    
    console.log(`\nProcessed ${processedCount} JS files with edge case replacements`);
    console.log("\n--- JS edge case processing phase complete ---\n");
}

/**
 * Process navigation links to add base tag and fix relative paths
 * @param {Object} collectedData - The data collected from all pages
 * @returns {Promise<void>}
 */
async function processNavigationLinks(collectedData) {
    console.log("\n--- Starting navigation link processing phase ---\n");
    
    // Process each HTML file
    let processedFileCount = 0;
    
    for (const page of collectedData.pages) {
        if (!page.htmlFile) continue;
        
        const htmlFilePath = path.join(OUTPUT_DIR, page.htmlFile);
        console.log(`Processing navigation links in: ${htmlFilePath}`);
        
        try {
            // Read the HTML file
            let htmlContent = await fs.readFile(htmlFilePath, 'utf8');
            
            // Simple direct approach: Add a script at the beginning of the head
            const headStartIndex = htmlContent.indexOf('<head>');
            if (headStartIndex !== -1) {
                const fixScript = `<head>
  <!-- Direct Link Fixer -->
  <script>
    // Store original addEventListener
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    
    // Override addEventListener to intercept all click events
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (type === 'click') {
        // Create a wrapped listener that will check for link clicks
        const wrappedListener = function(event) {
          // Handle link clicks
          if (event.target.tagName === 'A' || 
              (event.target.parentElement && event.target.parentElement.tagName === 'A')) {
            
            // Get the link element
            const link = event.target.tagName === 'A' ? event.target : event.target.parentElement;
            const href = link.getAttribute('href');
            
            // Check if it's an absolute path that needs to be fixed
            if (href && href.startsWith('/')) {
              // Prevent the default click behavior
              event.preventDefault();
              event.stopPropagation();
              
              // Convert absolute path to a local file reference
              // Strip the leading slash and add .html if needed
              let localPath = href.substring(1);
              if (!localPath.includes('.')) {
                localPath += '.html';
              }
              
              console.log('Intercepted click on', href, '- redirecting to', localPath);
              
              // Navigate directly
              window.location.href = localPath;
              return false;
            }
          }
          
          // Otherwise call the original listener
          return listener.call(this, event);
        };
        
        // Call the original addEventListener with our wrapped listener
        return originalAddEventListener.call(this, type, wrappedListener, options);
      }
      
      // For non-click events, just pass through
      return originalAddEventListener.call(this, type, listener, options);
    };
    
    // Execute on page load to fix any links
    window.addEventListener('DOMContentLoaded', function() {
      document.querySelectorAll('a[href^="/"]').forEach(function(link) {
        const href = link.getAttribute('href');
        let localPath = href.substring(1);
        
        // Add .html extension if needed
        if (!localPath.includes('.')) {
          localPath += '.html';
        }
        
        // Update the href
        link.setAttribute('href', localPath);
        
        // Add a direct click handler to be double-sure
        link.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          console.log('Direct link clicked:', localPath);
          window.location.href = localPath;
        }, true);
      });
    });
  </script>`;
                
                // Insert the script at the beginning of the head
                htmlContent = htmlContent.replace('<head>', fixScript);
                
                // Save the modified file
                await fs.writeFile(htmlFilePath, htmlContent);
                console.log(`Added direct link fixer script to ${htmlFilePath}`);
                processedFileCount++;
            } else {
                console.warn(`Could not find <head> tag in ${htmlFilePath}`);
            }
            
        } catch (error) {
            console.error(`Error processing navigation links in ${htmlFilePath}: ${error.message}`);
        }
    }
    
    console.log(`\nProcessed ${processedFileCount} HTML files with direct link fixer script`);
    console.log("\n--- Navigation link processing phase complete ---\n");
}

/**
 * Extract Next.js data from HTML files and save it to JSON folder
 * @param {Object} collectedData - The data collected from all pages
 * @returns {Promise<void>}
 */
async function extractNextJsData(collectedData) {
    // Delegate to the jsonExtractor module
    await jsonExtractor.extractNextJsData(collectedData, OUTPUT_DIR, JSON_DIR);
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
    await ensureOutputDir(JSON_DIR);
    
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
            },
            extractedNextJsData: 0
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
    
    // Phase 3: Process HTML files
    await processHtmlFiles(collectedData);
    
    // Phase 4: Process CSS files
    await processCssFiles(collectedData);
    
    // Phase 5: Process JS files
    await processJsFiles(collectedData);
    
    // Phase 6: Process JS edge cases
    await processJsFileEdgeCases(collectedData);
    
    // Phase 7: Process navigation links
    await processNavigationLinks(collectedData);
    
    // Phase 8: Extract Next.js data
    await extractNextJsData(collectedData);
    
    // Phase 9: Save the final data
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