const fs = require('fs/promises');
const path = require('path');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { URL } = require('url');

// --- Configuration ---
const BASE_URL = 'https://docs.cursor.com';
const OUTPUT_DIR = 'output-spa';
const ASSETS_DIR = path.join(OUTPUT_DIR, 'assets');
const CSS_DIR = path.join(OUTPUT_DIR, 'css');
const JS_DIR = path.join(OUTPUT_DIR, 'js');
const FONTS_DIR = path.join(OUTPUT_DIR, 'fonts');
const DATA_DIR = path.join(OUTPUT_DIR, 'data');
const ROUTES_DIR = path.join(DATA_DIR, 'routes');
const WAIT_TIME = 3000; // Time to wait for page to fully load in ms
const MAX_PAGES = 5; // Maximum number of pages to process (set to -1 for unlimited)
const DEBUG = true; 
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

/**
 * Creates the output directory if it doesn't exist.
 */
async function ensureOutputDirs() {
    try {
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        await fs.mkdir(ASSETS_DIR, { recursive: true });
        await fs.mkdir(CSS_DIR, { recursive: true });
        await fs.mkdir(JS_DIR, { recursive: true });
        await fs.mkdir(FONTS_DIR, { recursive: true });
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(ROUTES_DIR, { recursive: true });
        console.log(`Output directories created successfully.`);
    } catch (error) {
        console.error(`Error creating output directories:`, error);
        throw error;
    }
}

/**
 * Makes a safe filename from a URL
 */
function makeSafeFilename(url) {
    try {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname;
        
        // For routes, just use the pathname
        if (pathname === '/') return 'index';
        
        // Remove leading slash and replace remaining slashes
        return pathname.replace(/^\//, '').replace(/\//g, '-').replace(/[^a-z0-9.-]/gi, '_');
    } catch (error) {
        return 'route_' + Buffer.from(url).toString('base64').replace(/[^a-z0-9]/gi, '_').substring(0, 50);
    }
}

/**
 * Categorize the resource URL by type
 */
function categorizeResource(url) {
    const lowerUrl = url.toLowerCase();
    const extension = lowerUrl.split('.').pop().split('?')[0];
    
    if (lowerUrl.endsWith('.css') || lowerUrl.includes('.css?') || extension === 'css') {
        return 'css';
    } else if (lowerUrl.endsWith('.js') || lowerUrl.includes('.js?') || extension === 'js') {
        return 'js';
    } else if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) {
        return 'font';
    } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'avif', 'svg'].includes(extension)) {
        return 'image';
    } else {
        return 'other';
    }
}

/**
 * Collects all resources on a page
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<string[]>} - Array of resource URLs
 */
async function collectPageResources(page) {
    // Get all resources from the page
    const resources = await page.evaluate(() => {
        const items = [];
            
        // Get all style, script, and image resources
        document.querySelectorAll('link[rel="stylesheet"], script[src], img[src], source[src]').forEach(el => {
            let url;
            if (el.tagName === 'LINK') url = el.href;
            else if (el.tagName === 'SCRIPT') url = el.src;
            else url = el.src;
                
            if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
                items.push(url);
            }
        });
            
        return [...new Set(items)]; // Return unique items
    });
    
    return resources;
}

/**
 * Collects all navigation links on a page
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
 * Downloads a resource and saves it to the appropriate directory
 */
async function downloadResource(url) {
    try {
        const category = categorizeResource(url);
        let outputDir;
        
        // Determine output directory based on resource type
        switch (category) {
            case 'css': outputDir = CSS_DIR; break;
            case 'js': outputDir = JS_DIR; break;
            case 'font': outputDir = FONTS_DIR; break;
            case 'image': outputDir = ASSETS_DIR; break;
            default: outputDir = ASSETS_DIR;
        }
        
        // Create safe filename
        const filename = path.basename(url).replace(/[^a-z0-9.-]/gi, '_');
        const safePath = `${outputDir}/${filename}`;
        
        // Check if already downloaded
        try {
            await fs.access(safePath);
            return { path: safePath, category };
        } catch (e) {
            // Not downloaded yet, continue
        }
        
        // Download the resource
        const response = await axios.get(url, {
            responseType: category === 'css' || category === 'js' ? 'text' : 'arraybuffer',
            headers: { 'User-Agent': USER_AGENT }
        });
        
        // Save file
        await fs.writeFile(safePath, response.data);
        console.log(`Downloaded: ${url} -> ${safePath}`);
        
        return { path: safePath, category };
    } catch (error) {
        console.error(`Error downloading ${url}:`, error.message);
        return null;
    }
}

/**
 * Helper function for waiting
 */
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Capture the route content
 */
async function captureRouteContent(page, path) {
    // Get the main content of the page
    const content = await page.evaluate(() => {
        // Find the main content area - adjust selector based on actual site structure
        const mainContent = document.querySelector('main') || 
                           document.querySelector('#__next') || 
                           document.querySelector('.app-content') ||
                           document.querySelector('body');
        
        if (mainContent) {
            return mainContent.innerHTML;
        }
        return null;
    });
    
    return content;
}

/**
 * Process a single page
 */
async function processPage(page, urlPath, processedPaths, pathsToProcess, routeData) {
    const fullUrl = BASE_URL + urlPath;
    
    console.log(`\nProcessing: ${fullUrl}`);

    // Skip if already processed
    if (processedPaths.has(urlPath)) {
        console.log(`Already processed: ${urlPath}`);
        return;
    }
                        
    // Mark as processed
    processedPaths.add(urlPath);
    
    try {
        // Navigate to the page
        await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait a bit more for dynamic content
        await wait(WAIT_TIME);
        
        // Get page title
        const title = await page.title();
        
        // Get the current route's content
        const content = await captureRouteContent(page);
        
        if (content) {
            // Save route content
            const routeFileName = makeSafeFilename(urlPath) + '.html';
            const routeFilePath = path.join(ROUTES_DIR, routeFileName);
            await fs.writeFile(routeFilePath, content);
            
            // Add to route data
            routeData.routes.push({
                path: urlPath,
                title: title,
                contentFile: routeFileName
            });
        }
        
        // Collect resources (for later download)
        const resources = await collectPageResources(page);
        for (const url of resources) {
            if (!routeData.resources.has(url)) {
                routeData.resources.set(url, null); // Mark for download later
            }
        }
        
        // Collect navigation links
        const links = await collectNavigationLinks(page, BASE_URL);
        
        // Add links to processing queue
        for (const link of links) {
            if (!processedPaths.has(link.path) && !pathsToProcess.has(link.path)) {
                console.log(`Queueing: ${link.path}`);
                pathsToProcess.add(link.path);
            }
        }
        
    } catch (error) {
        console.error(`Error processing ${fullUrl}:`, error.message);
    }
}

/**
 * Capture the base HTML structure
 */
async function captureBaseStructure(page) {
    console.log("Capturing base HTML structure...");
    
    try {
        // Navigate to homepage
        console.log(`Navigating to ${BASE_URL}...`);
        await page.goto(BASE_URL, { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        }).catch(e => {
            console.error(`Navigation error: ${e.message}`);
            throw e;
        });
        
        console.log("Page loaded, waiting for additional content...");
        await wait(WAIT_TIME);
        
        // Get the full HTML
        console.log("Getting page content...");
        const html = await page.content();
        
        // Save the base HTML
        console.log("Saving base HTML...");
        await fs.writeFile(path.join(OUTPUT_DIR, 'index.html'), html);
        
        console.log("Base HTML structure captured and saved.");
        
        return html;
    } catch (error) {
        console.error("Error capturing base structure:", error);
        throw error;
    }
}

/**
 * Helper function to safely stringify JSON, escaping special characters
 */
function safeStringify(obj) {
    return JSON.stringify(obj, function(key, value) {
        // Convert any special characters in strings to escape sequences
        if (typeof value === 'string') {
            return value
                .replace(/\\/g, '\\\\')   // Backslash
                .replace(/"/g, '\\"')     // Double quotes
                .replace(/\n/g, '\\n')    // Newlines
                .replace(/\r/g, '\\r')    // Carriage returns
                .replace(/\t/g, '\\t')    // Tabs
                .replace(/\f/g, '\\f')    // Form feeds
                .replace(/[\u0000-\u001F\u2028\u2029]/g, function(character) {
                    // Special escape for control characters and line/paragraph separators
                    return '\\u' + ('0000' + character.charCodeAt(0).toString(16)).slice(-4);
                });
        }
        return value;
    }, 2);
}

/**
 * Create router.js to handle client-side routing
 */
async function createRouter(routeData) {
    console.log("Creating router with embedded content...");
    
    // First, load all route content files into memory
    // We'll use a different approach - create a separate JS file with route contents
    // to avoid issues with embedding large HTML in JavaScript strings
    const routeContentsObj = {};
    for (const route of routeData.routes) {
        const filePath = path.join(ROUTES_DIR, route.contentFile);
        try {
            let content = await fs.readFile(filePath, 'utf8');
            routeContentsObj[route.path] = content;
        } catch (error) {
            console.error(`Error reading route content for ${route.path}:`, error.message);
        }
    }
    
    // Create a separate JS file for route contents
    const routeContentsJs = `
    // Route contents for offline SPA
    var ROUTE_CONTENTS = ${safeStringify(routeContentsObj)};
    `;
    
    await fs.writeFile(path.join(JS_DIR, 'route-contents.js'), routeContentsJs);
    console.log("Route contents JS file created successfully.");
    
    // Create the main router
    const routerJs = `
    // SPA Router for offline browsing
    document.addEventListener('DOMContentLoaded', function() {
        // Route data
        const routes = ${safeStringify(routeData.routes)};
        
        // Route contents are loaded from a separate file: route-contents.js
        // This avoids issues with embedding large HTML in JavaScript
        const routeContents = window.ROUTE_CONTENTS || {};
        
        // Main content element - adjust selector based on site structure
        const contentElement = document.querySelector('main') || 
                               document.querySelector('#__next') || 
                               document.querySelector('.app-content');
        
        if (!contentElement) {
            console.error('Could not find main content element');
            return;
        }
        
        // Simple loading indicator
        function showLoading() {
            const existingLoader = document.getElementById('page-loader');
            if (existingLoader) return;
            
            const loader = document.createElement('div');
            loader.id = 'page-loader';
            loader.innerHTML = '<div style="width:40px;height:40px;border:4px solid #f3f3f3;border-top:4px solid #3498db;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto;"></div><p style="text-align:center;margin-top:10px;">Loading...</p>';
            loader.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.8);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;';
            document.body.appendChild(loader);
            
            // Add animation styles if not already present
            if (!document.getElementById('loader-styles')) {
                const style = document.createElement('style');
                style.id = 'loader-styles';
                style.textContent = '@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}';
                document.head.appendChild(style);
            }
        }
        
        function hideLoading() {
            const loader = document.getElementById('page-loader');
            if (loader) loader.remove();
        }
        
        // Current path being displayed
        let currentPath = '/';
        
        // Detect if we're running from a web server or file system
        const isWebServer = window.location.protocol !== 'file:';
        
        // Function to load route content
        function loadRouteContent(path) {
            showLoading();
            
            // Process path - remove any extra parts after hash or query string
            let cleanPath = path.split('#')[0].split('?')[0];
            if (!cleanPath) cleanPath = '/';
            
            // Save current path for later reference
            currentPath = cleanPath;
            
            // Find matching route
            const route = routes.find(r => r.path === cleanPath);
            
            if (route && routeContents[route.path]) {
                // Get the content from our pre-loaded data
                const content = routeContents[route.path];
                
                // Update document title
                document.title = route.title;
                
                // Update content
                contentElement.innerHTML = content;
                
                // Update URL for navigation history
                if (isWebServer) {
                    // On a web server - use proper HTML5 history API
                    window.history.pushState({path: cleanPath}, route.title, cleanPath);
                } else {
                    // On file system - use hash-based URLs
                    if (window.location.hash.replace('#', '') !== cleanPath) {
                        window.location.hash = cleanPath;
                    }
                }
            } else {
                // Try to find closest route if exact match not found
                const bestMatch = routes.find(r => cleanPath.startsWith(r.path + '/')) || 
                                routes.find(r => r.path === '/'); // Fallback to home
                
                if (bestMatch) {
                    console.warn('Route not found:', cleanPath, 'Redirecting to:', bestMatch.path);
                    loadRouteContent(bestMatch.path);
                    return;
                } else {
                    // If we can't find any matching route, show error and go to home
                    console.error('Route not found:', cleanPath);
                    contentElement.innerHTML = '<div style="padding: 20px; text-align: center;"><h1>Page Not Found</h1><p>Sorry, the page you requested could not be found.</p><p><a href="#/" onclick="window.loadRouteContent(\\'/\\');return false;">Go to Home</a></p></div>';
                }
            }
            
            // Hide loading indicator with slight delay
            setTimeout(hideLoading, 100);
        }
        
        // Make loadRouteContent available globally
        window.loadRouteContent = loadRouteContent;
        
        // Set up routing based on environment
        if (isWebServer) {
            // Web server - use HTML5 History API
            const initialPath = window.location.pathname || '/';
            
            // Handle browser back/forward navigation
            window.addEventListener('popstate', function(e) {
                const path = e.state?.path || window.location.pathname || '/';
                if (path !== currentPath) {
                    loadRouteContent(path);
                }
            });
            
            // Initial load
            loadRouteContent(initialPath);
        } else {
            // File system - use hash-based routing
            const hashPath = window.location.hash.substring(1);
            const initialPath = hashPath || '/';
            
            // Set up hash change listener for navigation
            window.addEventListener('hashchange', function() {
                const path = window.location.hash.substring(1) || '/';
                if (path !== currentPath) {
                    loadRouteContent(path);
                }
            });
            
            // Initial load
            loadRouteContent(initialPath);
        }
        
        // Handle navigation clicks
        document.addEventListener('click', function(e) {
            // Find closest anchor element
            const anchor = e.target.closest('a');
            
            if (anchor) {
                const href = anchor.getAttribute('href');
                
                // Skip if it's not an internal link
                if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:')) {
                    return;
                }
                
                // Skip if it's just an anchor link
                if (href === '#') {
                    return;
                }
                
                // Skip if it's a hash link and already being handled by hashchange
                if (!isWebServer && href.startsWith('#') && href.length > 1) {
                    return;
                }
                
                // Process internal links
                e.preventDefault();
                
                // Get path based on link type
                let linkPath;
                if (href.startsWith('/')) {
                    // Absolute path
                    linkPath = href;
                } else if (href.startsWith('#/')) {
                    // Hash-based path
                    linkPath = href.substring(1);
                } else if (href.startsWith('#')) {
                    // Just a hash fragment - not a route change
                    return;
                } else {
                    // Relative path - resolve against current path
                    const base = currentPath.endsWith('/') ? currentPath : currentPath + '/';
                    linkPath = base + href;
                }
                
                // Load the new route
                if (isWebServer) {
                    loadRouteContent(linkPath);
                } else {
                    window.location.hash = linkPath;
                }
            }
        });
    });
    `;
    
    await fs.writeFile(path.join(JS_DIR, 'router.js'), routerJs);
    console.log("Router.js created successfully with separate route contents.");
}

/**
 * Create a startup.sh script to run the local server
 */
async function createStartupScripts() {
    // Create a simple README file
    const readmeContent = `# Mintlify Docs - Offline Archive

This is an offline archive of a Mintlify-powered documentation website.

## How to View

There are two ways to view this archive:

### Option 1: Using a web server (recommended)

Run one of these commands in your terminal, in this directory:

\`\`\`bash
# If you have Node.js installed:
npx http-server . -p 8080

# If you have Python installed:
# Python 3
python -m http.server 8080
# Python 2 
python -m SimpleHTTPServer 8080
\`\`\`

Then open http://localhost:8080 in your web browser.

### Option 2: Direct file access (limited functionality)

Open the \`index.html\` file directly in your browser. However, some routing functions will be limited.

## Navigation

This archive preserves the original site's navigation. Click on links to navigate between pages.
`;

    // Create Windows batch file
    const batchContent = `@echo off
echo Starting local web server for Mintlify Docs offline archive...
echo.
echo Please keep this window open while browsing the documentation.
echo When done, close this window or press Ctrl+C to stop the server.
echo.
echo Opening http://localhost:8080 in your default browser...
start http://localhost:8080
npx http-server . -p 8080
`;

    // Create bash script
    const bashContent = `#!/bin/bash
echo "Starting local web server for Mintlify Docs offline archive..."
echo ""
echo "Please keep this window open while browsing the documentation."
echo "When done, close this window or press Ctrl+C to stop the server."
echo ""
echo "Opening http://localhost:8080 in your default browser..."
if command -v xdg-open > /dev/null; then
  xdg-open http://localhost:8080
elif command -v open > /dev/null; then
  open http://localhost:8080
fi
npx http-server . -p 8080
`;

    // Save the files
    await fs.writeFile(path.join(OUTPUT_DIR, 'README.md'), readmeContent);
    await fs.writeFile(path.join(OUTPUT_DIR, 'start.bat'), batchContent);
    await fs.writeFile(path.join(OUTPUT_DIR, 'start.sh'), bashContent);
    
    // Make the bash script executable (on Unix systems)
    try {
        await fs.chmod(path.join(OUTPUT_DIR, 'start.sh'), 0o755);
    } catch (e) {
        // Ignore on Windows
    }
    
    console.log("Created startup scripts and README.");
}

/**
 * Main function
 */
async function main() {
    console.log("Starting SPA scraper...");
    
    // Ensure output directories exist
    await ensureOutputDirs();
    
    // Launch browser with more explicit options
    console.log("Launching browser...");
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    
    console.log("Browser launched successfully");
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    
    try {
        // Capture the base HTML structure
        await captureBaseStructure(page);
        
        // Data collection
        const routeData = {
            routes: [],
            resources: new Map()
        };
        
        // Process pages
        const processedPaths = new Set();
        const pathsToProcess = new Set(['/']); // Start with homepage
        
        let processedCount = 0;
        
        // Process all pages one by one
        while (pathsToProcess.size > 0 && (MAX_PAGES < 0 || processedCount < MAX_PAGES)) {
            // Get next path
            const currentPath = Array.from(pathsToProcess)[0];
            pathsToProcess.delete(currentPath);
            
            // Process the page
            await processPage(page, currentPath, processedPaths, pathsToProcess, routeData);
            processedCount++;
            
            console.log(`Progress: ${processedCount} pages processed, ${pathsToProcess.size} in queue`);
        }
        
        console.log("\nDownloading resources...");
        
        // Download all resources
        let downloadsComplete = 0;
        for (const url of routeData.resources.keys()) {
            const result = await downloadResource(url);
            if (result) {
                routeData.resources.set(url, result.path);
            }
            
            downloadsComplete++;
            if (downloadsComplete % 10 === 0) {
                console.log(`Downloaded ${downloadsComplete}/${routeData.resources.size} resources`);
            }
        }
        
        // Convert Map to Array for JSON
        const resourcesArray = [];
        for (const [url, localPath] of routeData.resources.entries()) {
            if (localPath) {
                resourcesArray.push({ url, localPath: path.relative(OUTPUT_DIR, localPath) });
            }
        }
        
        // Create final routes data
        const finalRouteData = {
            routes: routeData.routes,
            resources: resourcesArray
        };
        
        // Save route data to JSON
        await fs.writeFile(
            path.join(DATA_DIR, 'routes.json'), 
            JSON.stringify(finalRouteData, null, 2)
        );
        
        // Create router.js
        await createRouter(finalRouteData);
        
        // Update index.html to include our router.js
        const indexPath = path.join(OUTPUT_DIR, 'index.html');
        let indexHtml = await fs.readFile(indexPath, 'utf8');
        
        // Add our script files right before closing body tag
        indexHtml = indexHtml.replace('</body>', `
    <script src="./js/route-contents.js"></script>
    <script src="./js/router.js"></script>
</body>`);
        
        // Replace resource URLs with local paths
        for (const resource of resourcesArray) {
            // Create relative path
            const localPath = resource.localPath;
            
            // Replace all instances of the URL
            indexHtml = indexHtml.replace(new RegExp(resource.url, 'g'), localPath);
            
            // Also try with the URL minus the base
            const relativeUrl = resource.url.replace(BASE_URL, '');
            if (relativeUrl.startsWith('/')) {
                indexHtml = indexHtml.replace(new RegExp(relativeUrl, 'g'), localPath);
            }
        }
        
        // Save updated index.html
        await fs.writeFile(indexPath, indexHtml);
        
        // Create startup scripts
        await createStartupScripts();
        
        console.log("\nSPA scraping complete!");
        console.log("To view the site with full routing support:");
        console.log("  1. Navigate to the output-spa directory");
        console.log("  2. Run: npx http-server . -p 8080");
        console.log("  3. Open http://localhost:8080 in your browser");
        console.log("\nAlternatively, you can double-click start.bat (Windows) or run ./start.sh (Mac/Linux)");
        
    } finally {
        await browser.close();
    }
}

// Run the script
main().catch(error => {
    console.error("An unexpected error occurred:", error);
    process.exit(1);
}); 