/**
 * JSON Extractor Module
 * 
 * This module handles the extraction and parsing of Next.js data from HTML files.
 * It extracts JSON data from __NEXT_DATA__ script tags and parses compiledSource
 * content into structured, readable JSON.
 */

const fs = require('fs/promises');
const path = require('path');

// Debug flag - this should be imported from a config file in a real application
const DEBUG = process.env.DEBUG === 'true';

/**
 * Extracts Next.js data from HTML files
 * @param {Object} collectedData - The data collected from all pages
 * @param {string} outputDir - The base output directory
 * @param {string} jsonDir - The directory to save JSON files
 * @returns {Promise<void>}
 */
async function extractNextJsData(collectedData, outputDir, jsonDir) {
    console.log("\n--- Starting Next.js data extraction phase ---\n");
    
    let extractedCount = 0;
    
    // Process each HTML file to extract the Next.js data
    for (const page of collectedData.pages) {
        if (!page.htmlFile) continue;
        
        const htmlFilePath = path.join(outputDir, page.htmlFile);
        
        try {
            // Read the HTML file
            const htmlContent = await fs.readFile(htmlFilePath, 'utf8');
            
            // Find the __NEXT_DATA__ script which contains JSON data
            const nextDataMatch = htmlContent.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            
            if (nextDataMatch && nextDataMatch[1]) {
                try {
                    // Parse the JSON
                    const jsonData = JSON.parse(nextDataMatch[1]);
                    
                    // Create a filename based on the page path
                    const jsonFilename = page.path === '/' 
                        ? 'index.json' 
                        : (page.path.replace(/^\//, '').replace(/\//g, '-') + '.json');
                    
                    // Save the JSON to the json directory
                    const jsonFilePath = path.join(jsonDir, jsonFilename);
                    await fs.writeFile(jsonFilePath, JSON.stringify(jsonData, null, 2));
                    
                    // Add the json file path to the page data
                    page.nextJsDataFile = path.relative(outputDir, jsonFilePath);
                    
                    console.log(`Extracted Next.js data from ${page.htmlFile} to ${jsonFilename}`);
                    extractedCount++;
                } catch (parseError) {
                    console.error(`Error parsing Next.js data in ${page.htmlFile}: ${parseError.message}`);
                }
            }
        } catch (error) {
            console.error(`Error processing ${page.htmlFile} for Next.js data: ${error.message}`);
        }
    }
    
    console.log(`\nExtracted Next.js data from ${extractedCount} pages`);
    collectedData.stats.extractedNextJsData = extractedCount;
    
    console.log("\n--- Next.js data extraction phase complete ---\n");
}

/**
 * Parse the compiledSource content to extract meaningful data in JSON format
 * @param {string} compiledSource - The compiledSource content from Next.js data
 * @param {string} url - The URL of the page (optional)
 * @returns {Object} - Parsed content as a JSON object
 */
function parseCompiledSource(compiledSource, url) {
    // Create a base structure for our parsed content
    const parsedContent = {
        title: "",
        url: url || "", // Add the URL to the parsed content
        meta: {
            extractedAt: new Date().toISOString(),
            contentType: compiledSource.includes('MDXContent') ? 'MDX' : 'Unknown'
        },
        elements: [] // All elements in their original order
    };
    
    try {
        // Store element matches with their positions to maintain order
        const elementMatches = [];
        
        // Try to find a title
        const titleMatch = /useMDXComponents[\s\S]*?title:\s*["']([^"']+)["']/.exec(compiledSource);
        if (titleMatch) {
            parsedContent.title = titleMatch[1];
        }
        
        // Extract all heading sections with their level and ID
        const headingRegex = /_jsx\(Heading,\s*{\s*level:\s*["'](\d+)["'],\s*id:\s*["']([^"']+)["'],\s*children:\s*["']([^"']+)["']/g;
        let headingMatch;
        while ((headingMatch = headingRegex.exec(compiledSource)) !== null) {
            elementMatches.push({
                type: 'heading',
                position: headingMatch.index,
                data: {
                    level: headingMatch[1],
                    id: headingMatch[2],
                    text: headingMatch[3]
                }
            });
        }
        
        // Extract accordion content with better text extraction FIRST - to avoid duplication
        const accordionRegex = /_jsx\(Accordion,\s*{\s*title:\s*["']([^"']+)["']([\s\S]*?)}\)/g;
        let accordionMatch;
        const accordionContents = new Set(); // Track accordion contents to avoid duplication

        while ((accordionMatch = accordionRegex.exec(compiledSource)) !== null) {
            // Extract content from the accordion
            const contentMatch = /children:\s*([\s\S]*?)(?:,\s*\w+:|$)/.exec(accordionMatch[2]);
            const rawContent = contentMatch ? contentMatch[1].trim() : "";
            
            // Clean up the content to extract actual text
            let cleanContent = "";
            
            // Check if it's a simple text content with direct string
            const simpleTextMatch = /children:\s*["']([^"']+)["']/.exec(rawContent);
            if (simpleTextMatch) {
                cleanContent = simpleTextMatch[1];
            } 
            // Check for simple paragraph component
            else if (rawContent.includes('_jsx(_components.p,')) {
                const paragraphMatch = /children:\s*["']([^"']+)["']/.exec(rawContent);
                if (paragraphMatch) {
                    cleanContent = paragraphMatch[1];
                }
            }
            // For more complex content, do deeper extraction
            else {
                // For complex content, extract all text parts
                const textParts = [];
                
                // Extract all string literals
                const stringLiteralRegex = /["']([^"']+)["']/g;
                let stringMatch;
                while ((stringMatch = stringLiteralRegex.exec(rawContent)) !== null) {
                    textParts.push(stringMatch[1]);
                }
                
                // Extract text from nested children in jsx calls
                const jsxChildrenRegex = /_jsx\([^,]+,\s*{\s*[^}]*?children:\s*["']([^"']+)["'][^}]*}\)/g;
                let jsxMatch;
                while ((jsxMatch = jsxChildrenRegex.exec(rawContent)) !== null) {
                    textParts.push(jsxMatch[1]);
                }
                
                cleanContent = textParts.join(' ').replace(/\s+/g, ' ').trim();
                
                // If we couldn't extract anything, try a simpler approach
                if (!cleanContent) {
                    cleanContent = rawContent
                        .replace(/_jsx\(_components\.[^{]+{/g, '')
                        .replace(/_jsxs\(_components\.[^{]+{/g, '')
                        .replace(/children:/g, '')
                        .replace(/[{}()\[\]]/g, '')
                        .replace(/,/g, ' ')
                        .replace(/["']/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                }
            }
            
            // Add the accordion content to our tracking set
            if (cleanContent) {
                accordionContents.add(cleanContent);
            }
            
            elementMatches.push({
                type: 'accordion',
                position: accordionMatch.index,
                data: {
                    title: accordionMatch[1],
                    content: cleanContent
                }
            });
        }
        
        // Extract simple paragraphs - AVOID DUPLICATING ACCORDION CONTENT
        const paragraphSimpleRegex = /_jsx\(_components\.p,\s*{\s*children:\s*["']([^"']+)["']/g;
        let paragraphMatch;
        while ((paragraphMatch = paragraphSimpleRegex.exec(compiledSource)) !== null) {
            const paragraphText = paragraphMatch[1];
            
            // Skip if this content is already in an accordion
            if (accordionContents.has(paragraphText)) {
                continue;
            }
            
            elementMatches.push({
                type: 'paragraph',
                position: paragraphMatch.index,
                data: {
                    text: paragraphText,
                    style: 'simple'
                }
            });
        }
        
        // Extract more complex paragraphs with JSX arrays
        const paragraphComplexRegex = /_jsxs\(_components\.p,\s*{\s*children:\s*\[([\s\S]*?)\]\s*}\)/g;
        let complexParagraphMatch;
        while ((complexParagraphMatch = paragraphComplexRegex.exec(compiledSource)) !== null) {
            // Extract the raw content first
            const rawContent = complexParagraphMatch[1].trim();
            
            // Process the content to extract all text parts
            // This more sophisticated approach handles nested components
            const textParts = [];
            
            // Extract all direct string literals
            const stringLiteralRegex = /["']([^"']+)["']/g;
            let stringMatch;
            while ((stringMatch = stringLiteralRegex.exec(rawContent)) !== null) {
                textParts.push(stringMatch[1]);
            }
            
            // Extract text from child components
            const childComponentRegex = /_jsx\(_components\.[^,]+,\s*{\s*[^}]*?children:\s*["']([^"']+)["']/g;
            let childMatch;
            while ((childMatch = childComponentRegex.exec(rawContent)) !== null) {
                textParts.push(childMatch[1]);
            }
            
            // Extract text from nested complex components
            const nestedComponentRegex = /_jsx\(_components\.([^,]+),\s*{[^}]*}\)/g;
            let nestedMatch;
            while ((nestedMatch = nestedComponentRegex.exec(rawContent)) !== null) {
                // Extract the component type for context (e.g., strong, em)
                const componentType = nestedMatch[1];
                
                // Find any children within this component
                const nestedContent = nestedMatch[0];
                const nestedChildMatch = /children:\s*["']([^"']+)["']/.exec(nestedContent);
                
                if (nestedChildMatch) {
                    // For emphasis components, we might want to add formatting indicators
                    if (componentType === 'strong') {
                        textParts.push(`**${nestedChildMatch[1]}**`);
                    } else if (componentType === 'em') {
                        textParts.push(`*${nestedChildMatch[1]}*`);
                    } else {
                        textParts.push(nestedChildMatch[1]);
                    }
                }
            }
            
            // Create a clean text representation
            const cleanText = textParts.join(' ').replace(/\s+/g, ' ').trim();
            
            // If we couldn't extract much, try a more aggressive approach
            let finalText = cleanText;
            if (cleanText.length < 10 && rawContent.length > 20) {
                finalText = rawContent
                    .replace(/_jsx\(_components\.[^{]+{/g, '')
                    .replace(/_jsxs\(_components\.[^{]+{/g, '')
                    .replace(/children:/g, '')
                    .replace(/[{}()\[\]]/g, '')
                    .replace(/,/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                
                // Pull out text between quotes if available
                const quotedText = [];
                const quoteRegex = /["']([^"']+)["']/g;
                let quoteMatch;
                while ((quoteMatch = quoteRegex.exec(finalText)) !== null) {
                    quotedText.push(quoteMatch[1]);
                }
                
                if (quotedText.length > 0) {
                    finalText = quotedText.join(' ');
                }
            }
            
            // Skip if this content is already in an accordion
            if (accordionContents.has(finalText)) {
                continue;
            }
            
            elementMatches.push({
                type: 'paragraph',
                position: complexParagraphMatch.index,
                data: {
                    text: finalText,
                    style: 'complex'
                }
            });
        }
        
        // Extract list items
        const listItemRegex = /_jsx\(_components\.li,\s*{\s*children:\s*["']([^"']+)["']/g;
        let listItemMatch;
        while ((listItemMatch = listItemRegex.exec(compiledSource)) !== null) {
            elementMatches.push({
                type: 'listItem',
                position: listItemMatch.index,
                data: {
                    text: listItemMatch[1]
                }
            });
        }
        
        // Extract all links with href and text
        const linkRegex = /_jsx\(_components\.a,\s*{\s*href:\s*["']([^"']+)["'],\s*children:\s*["']([^"']+)["']/g;
        let linkMatch;
        while ((linkMatch = linkRegex.exec(compiledSource)) !== null) {
            elementMatches.push({
                type: 'link',
                position: linkMatch.index,
                data: {
                    url: linkMatch[1],
                    text: linkMatch[2]
                }
            });
        }
        
        // Extract nested links with complex children
        const complexLinkRegex = /_jsx\(_components\.a,\s*{\s*href:\s*["']([^"']+)["'],\s*children:\s*_jsx\(_components\.([^,]+),\s*{\s*children:\s*["']([^"']+)["']/g;
        let complexLinkMatch;
        while ((complexLinkMatch = complexLinkRegex.exec(compiledSource)) !== null) {
            elementMatches.push({
                type: 'link',
                position: complexLinkMatch.index,
                data: {
                    url: complexLinkMatch[1],
                    text: complexLinkMatch[3],
                    emphasisType: complexLinkMatch[2] // strong, em, etc.
                }
            });
        }
        
        // Extract card content
        const cardRegex = /_jsx\(Card,\s*{\s*title:\s*["']([^"']+)["'],\s*icon:\s*["']([^"']+)["']([\s\S]*?)}\)/g;
        let cardMatch;
        while ((cardMatch = cardRegex.exec(compiledSource)) !== null) {
            const hrefMatch = /href:\s*["']([^"']+)["']/.exec(cardMatch[3]);
            const childrenMatch = /children:\s*_jsx\(_components\.p,\s*{\s*children:\s*["']([^"']+)["']\s*}\)/.exec(cardMatch[3]);
            
            elementMatches.push({
                type: 'card',
                position: cardMatch.index,
                data: {
                    title: cardMatch[1],
                    icon: cardMatch[2],
                    url: hrefMatch ? hrefMatch[1] : "",
                    description: childrenMatch ? childrenMatch[1] : ""
                }
            });
        }
        
        // Extract images
        const imageRegex = /_jsx\(_components\.img,\s*{\s*src:\s*["']([^"']+)["'],\s*alt:\s*["']([^"']*)["']/g;
        let imageMatch;
        while ((imageMatch = imageRegex.exec(compiledSource)) !== null) {
            elementMatches.push({
                type: 'image',
                position: imageMatch.index,
                data: {
                    src: imageMatch[1],
                    alt: imageMatch[2] || ""
                }
            });
        }
        
        // Extract code blocks
        const codeRegex = /_jsx\(_components\.code,\s*{\s*children:\s*["']([^"']+)["']/g;
        let codeMatch;
        while ((codeMatch = codeRegex.exec(compiledSource)) !== null) {
            elementMatches.push({
                type: 'code',
                position: codeMatch.index,
                data: {
                    content: codeMatch[1]
                }
            });
        }
        
        // Extract blockquotes
        const blockquoteRegex = /_jsx\(_components\.blockquote,\s*{\s*children:/g;
        let blockquoteMatch;
        while ((blockquoteMatch = blockquoteRegex.exec(compiledSource)) !== null) {
            // Find the end of the blockquote
            const startPos = blockquoteMatch.index;
            let endPos = compiledSource.indexOf('}))', startPos);
            if (endPos > startPos) {
                const blockquoteContent = compiledSource.substring(startPos, endPos + 3);
                
                // Extract text from the blockquote
                const textMatch = /children:\s*["']([^"']+)["']/.exec(blockquoteContent);
                const text = textMatch ? textMatch[1] : "Complex blockquote";
                
                elementMatches.push({
                    type: 'blockquote',
                    position: startPos,
                    data: {
                        text: text
                    }
                });
            }
        }
        
        // Sort all elements by their position in the original content
        elementMatches.sort((a, b) => a.position - b.position);
        
        // Map the elementMatches to add to our final elements array
        const elements = [];
        
        // Process elementMatches to merge consecutive paragraphs of the same style
        for (let i = 0; i < elementMatches.length; i++) {
            const currentElement = elementMatches[i];
            
            // Check if this is a paragraph and there's a next element to potentially merge with
            if (currentElement.type === 'paragraph' && i + 1 < elementMatches.length) {
                // Start collecting a group of consecutive similar paragraphs
                const paragraphGroup = [currentElement];
                const style = currentElement.data.style;
                
                // Look ahead for consecutive paragraphs with same style
                let j = i + 1;
                while (j < elementMatches.length && 
                       elementMatches[j].type === 'paragraph' && 
                       elementMatches[j].data.style === style) {
                    paragraphGroup.push(elementMatches[j]);
                    j++;
                }
                
                if (paragraphGroup.length > 1) {
                    // We found consecutive paragraphs to merge
                    const mergedText = paragraphGroup
                        .map(p => p.data.text)
                        .join('\n\n'); // Join with double line breaks for clarity
                    
                    elements.push({
                        type: 'paragraph',
                        text: mergedText,
                        style: style
                    });
                    
                    // Skip the indices we've already processed
                    i = j - 1; // -1 because the loop will increment i
                } else {
                    // Just a single paragraph, add it as-is
                    elements.push({
                        type: currentElement.type,
                        ...currentElement.data
                    });
                }
            } else {
                // Not a paragraph or no consecutive paragraph to merge with
                elements.push({
                    type: currentElement.type,
                    ...currentElement.data
                });
            }
        }
        
        // Assign the processed elements to our parsed content
        parsedContent.elements = elements;
        
        // Extract component definitions separately, as they're not part of content flow
        const componentRegex = /const\s+([A-Za-z0-9_$]+)\s*=\s*\(\)\s*=>\s*{([\s\S]*?)return\s+([\s\S]*?)};/g;
        let componentMatch;
        const components = [];
        while ((componentMatch = componentRegex.exec(compiledSource)) !== null) {
            components.push({
                name: componentMatch[1],
                implementation: componentMatch[2].trim(),
                returnValue: componentMatch[3].trim()
            });
        }
        
        if (components.length > 0) {
            parsedContent.components = components;
        }
        
        // Clean up any remaining JSX patterns in the data
        cleanJsxFromObject(parsedContent);
        
        return parsedContent;
    } catch (error) {
        console.error("Error parsing compiledSource:", error);
        return {
            error: error.message,
            meta: {
                extractedAt: new Date().toISOString(),
                errorOccurred: true
            },
            content: {
                rawText: compiledSource
                    .replace(/_jsx\([^{]*{\s*children:\s*["']([^"']+)["']\s*}\)/g, "$1")
                    .replace(/_jsxs\([^{]*{\s*children:[^\]]*["']([^"']+)["'][^\]]*\]\s*}\)/g, "$1")
                    .replace(/[{}()\[\]]/g, "")
                    .replace(/\s+/g, " ")
                    .trim()
            }
        };
    }
}

/**
 * Clean up JSX patterns from an object's string properties
 * @param {Object} obj - The object to clean
 * @returns {Object} - The cleaned object
 */
function cleanJsxFromObject(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    
    Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'string') {
            // Clean up JSX patterns in strings
            obj[key] = obj[key]
                // Clean various JSX component patterns
                .replace(/_jsx\(_components\.[^,]+,\s*{\s*[^}]*?children:\s*["']([^"']+)["'][^}]*}\)/g, "$1")
                .replace(/_jsxs\(_components\.[^,]+,\s*{\s*[^}]*?children:[^\]]*}\)/g, "")
                // Clean remaining JSX syntax
                .replace(/_jsx\([^)]+\)/g, "")
                .replace(/_jsxs\([^)]+\)/g, "")
                .replace(/children:/g, "")
                .replace(/href:/g, "")
                .replace(/components\.[a-z]+/gi, "")
                // Clean punctuation left by JSX
                .replace(/[{}()\[\]]/g, "")
                .replace(/,(?!\d)/g, " ") // Replace commas not followed by a digit with a space
                // Clean extra spaces
                .replace(/\s+/g, " ")
                .trim();
        } else if (typeof obj[key] === 'object') {
            cleanJsxFromObject(obj[key]);
        }
    });
    
    return obj;
}

module.exports = {
    extractNextJsData,
    parseCompiledSource,
    cleanJsxFromObject
}; 