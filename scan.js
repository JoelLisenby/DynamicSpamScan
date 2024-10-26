import puppeteer from 'puppeteer';
import fs from 'fs';
import { encode } from 'html-entities';
import { URL } from 'url';

let isInterceptionSetUp = false;
let output = {results: []}; // Global object to store results

function shouldSkipUrl(url) {
    const skipPatterns = [
        /\/wp-content\//,
        /\/cart\//,
        /\/checkout\//,
        /\?add-to-cart=/
    ];
    return skipPatterns.some(pattern => pattern.test(url));
}

export async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve, reject) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

export async function crawlAndScan(page, currentUrl, visitedUrls, baseUrl, fs, parentOutput) {
    // Normalize URL by removing hash and ensuring it ends with a slash
    const normalizeUrl = url => {
        let normalized = url.split('#')[0].replace(/\/$/, ''); // Remove trailing slash if exists
        return normalized + '/'; // Add slash at the end
    };
    const normalizedUrl = normalizeUrl(currentUrl);

    if(shouldSkipUrl(normalizedUrl)) {
        logWithTimestamp(`Skipping URL: ${normalizedUrl}`);
        return parentOutput;
    }

    if (visitedUrls.has(normalizedUrl)) {
        return parentOutput;
    }

    visitedUrls.add(normalizedUrl);

    logWithTimestamp(`Scanning: ${normalizedUrl}`);

    // Request Interception setup
    if (!isInterceptionSetUp) {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (req.resourceType() === 'image' || req.resourceType() === 'media') {
                req.abort();
            } else {
                req.continue();
            }
        });
        isInterceptionSetUp = true;
    }

    await page.goto(currentUrl, {waitUntil: 'networkidle2'});
    await autoScroll(page);

    const itemsToCheck = fs.readFileSync('items.txt', 'utf-8').replace(/\r\n/g,'\n').split('\n').filter(Boolean);
    const foundItems = {};
    const pageContent = await page.content();
    const pageContentLower = pageContent.toLowerCase();

    function findInEachLine(fullText, searchString) {
        let results = [];
        let lines = fullText.replace(/\r\n/g,'\n').split('\n');
        let regSearchString = searchString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let escapedSearchString = ".*("+ regSearchString +").*";
        let regex = new RegExp(escapedSearchString, 'i');
        try {
            new RegExp(searchString);
            // If no error, then searchString might be intended as regex, so we'll use it directly
            regex = new RegExp(searchString, 'i');
        } catch(e) {
            // If there was an error creating regex from searchString, 
            // we've already escaped special characters above, so we proceed with escapedSearchString
        }
    
        lines.forEach((line, index) => {
            const match = line.match(regex);
            if( match ) {
                results.push({searchString:{
                    'regex': escapedSearchString,
                    'lineNumber': index + 1, // Adding 1 because line numbers typically start at 1, not 0
                    'lineContent': line,
                    'position': match.index
                }});
            }
        });
    
        return results;
    }

    let itemsFound = 0;
    itemsToCheck.forEach(item => {
        const found = findInEachLine(pageContentLower, item.toLowerCase());

        if (found.length > 0) {
            itemsFound++;
            foundItems[item] = {found};
        }
    });

    if( itemsFound > 0 ) {
        logWithTimestamp(`- found ${itemsFound} items!`);
    } else {
        logWithTimestamp(`- clean`);
    }

    const resultForUrl = {
        scanned_url: normalizedUrl,
        foundItems: foundItems
    };

    if (!parentOutput) {
        parentOutput = output;
    }
    
    // Check if this URL's results have already been added to avoid duplicates
    if (!parentOutput.results.some(result => result.scanned_url === normalizedUrl)) {
        parentOutput.results.push(resultForUrl);
    }

    const internalLinks = await page.$$eval(
        'a',
        (anchors, baseUrl) => 
            Array.from(new Set(anchors.map(a => {
                const href = a.href.split('#')[0];
                // Here, baseUrl is now accessible within the browser context
                return href.startsWith(baseUrl) && !href.match(/\.(png|jpg|jpeg|gif|svg|mp4|webm|ogg)$/i) ? href : null;
            }).filter(Boolean))),
        baseUrl // This is the variable being passed into the function
    );

    // Use Set for links to avoid processing duplicates within this page
    const uniqueLinks = new Set(internalLinks);

    for (let link of uniqueLinks) {
        if (!visitedUrls.has(link)) {
            await crawlAndScan(page, link, visitedUrls, baseUrl, fs, parentOutput);
        }
    }

    return parentOutput;
}

async function run(startUrl) {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    const visitedUrls = new Set();
    const baseUrl = new URL(startUrl).origin;
    const output = await crawlAndScan(page, startUrl, visitedUrls, baseUrl, fs);
    await browser.close();

    output['startUrl'] = startUrl;

    // Use the domain name from baseUrl for the file name
    const domainName = new URL(baseUrl).hostname;

    // Save the output to a JSON file
    try {
        await fs.writeFile(`${domainName}_crawl_output.json`, JSON.stringify(output, null, 2), (err) => err && console.error(err));
        console.log(`Crawl results saved to ${domainName}_crawl_output.json`);
    } catch (err) {
        console.error("Error writing file:", err);
    }

    // Save the output to a HTML file
    const raw_html = createHtmlTable(output);
    try {
        await fs.writeFile(`${domainName}_crawl_output.html`, raw_html, (err) => err && console.error(err));
        console.log(`Crawl results saved to ${domainName}_crawl_output.html`);
    } catch (err) {
        console.error("Error writing file:", err);
    }

}

function logWithTimestamp(message) {
    const now = new Date().toISOString();
    console.log(`${now} - ${message}`);
}

function highlightWord(text, word, caseSensitive = false) {
    // Check if parameters are valid
    if (typeof text !== 'string' || text.length === 0) {
        throw new Error('Text must be a non-empty string');
    }
    if (typeof word !== 'string' || word.length === 0) {
        throw new Error('Word must be a non-empty string');
    }
    
    // Regular expression setup
    let regex;
    if (caseSensitive) {
        regex = new RegExp(escapeRegExp(word), 'g');
    } else {
        regex = new RegExp(escapeRegExp(word), 'gi');
    }

    // Function to escape special characters in regex
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
    }

    // Function to wrap the matched text with highlight tags
    function wrapHighlight(match) {
        return `<span class="highlight">${match}</span>`;
    }

    // Replace all occurrences of the word or substring with the highlighted version
    return text.replace(regex, wrapHighlight);
}

function createHtmlTable(data) {
    let html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Scan Results for ${data.startUrl}</title>
        <style>
            body { font-family: Roboto, sans-serif; font-size: 12px; }
            a { color: #000; text-decoration: none; }
            a:hover { text-decoration: underline; }
            table { width: 100%; border-collapse: collapse; }
            body > table > tbody > tr > td { border-bottom: 4px solid #b1b1b1; }
            nav ul, nav ul li { list-style: none; padding: 0; margin: 0; }
            nav ul a { display: inline-block; margin: 5px 0; padding: 5px 10px; background-color: #efefef; border: 1px solid #cbcbcb; text-decoration: none; color: #000; }
            nav ul a:hover { background-color: #e0e0e0; text-decoration: none; }
            th, td { border: 1px solid #ddd; padding: 6px; text-align: left; }
            th { background-color: #f2f2f2; }
            th.title { vertical-align: top; }
            .sub-table { width: 100%; margin-top: 2px; border-bottom: 2px solid #c9c9c9; }
            .sub-table tbody { display: none; }
            .sub-table tbody.show { display: table-row-group; }
            .sub-table thead th { cursor: pointer; }
            .sub-table thead th:hover { background-color: #e0e0e0; }
            .sub-table tr td:first-child { width: 10%; font-weight: bold; }
            .sub-table tr td:last-child { width: 90%; }
            div.item_url { font-weight: bold; padding: 6px 0; }
            p { margin: 0; padding: 6px 0; }
            pre, code { max-width: 1200px; }
            pre { background: #f4f4f4; padding: 10px; border: 1px solid #ddd; }
            code { display: block; text-wrap: wrap; overflow-wrap: break-word;  font-family: 'Droid Sans Mono', monospace; }
            span.highlight { background-color: #aacae4; }
            @media print {
                .no-print, .no-print * { display: none !important; }
            }
        </style>
    </head>
    <body>

        <table>
            <thead>
                <tr>
                    <th><h1>Scan Results for ${data.startUrl}</h1></th>
                </tr>
                <tr>
                <nav class="no-print"><ul>
                <li><a href="#" id="toggle-all">Toggle All</a></li>
                </ul></nav>
                </tr>
            </thead>
            <tbody>
    `;

    for (let result of data.results) {
        html += `
                <tr>
                    <td><div class="item_url"><strong><a href="${encodeURI(result.scanned_url)}" target="_blank">${result.scanned_url}</a></strong></div>`;

        if (Object.keys(result.foundItems).length > 0) {
            for (let itemName in result.foundItems) {
                html += `<table class="sub-table">
                    <thead>
                        <tr>
                            <th colspan="2">${itemName}</th>
                        </tr>
                    </thead>
                    <tbody>`;

                for (let found of result.foundItems[itemName].found) {
                    let searchString = found.searchString;
                    html += `<tr>
                                <td>Line:</td>
                                <td><strong>${searchString.lineNumber.toString()}</strong> / Col ${searchString.position.toString()} / Regex: ${searchString.regex}</td>
                            </tr>
                            <tr>
                                <td>Line Content:</td>
                                <td><pre><code>${highlightWord(encode(searchString.lineContent),itemName)}</code></pre></td>
                            </tr>`;
                }
                html += `</tbody>
                        </table>`;
            }
        } else {
            html += `<p>No items found</p>`;
        }

        html += `</td>
                </tr>`;
    }

    html += `
            </tbody>
        </table>
        <script>
        document.addEventListener('DOMContentLoaded', function() {
            const items = document.querySelectorAll('table.sub-table > thead > tr > th');
            items.forEach(function(element) {
                element.addEventListener('click', function(e) {
                    const tbody = e.target.closest('table.sub-table').querySelector('tbody');
                    if(tbody) tbody.classList.toggle('show');
                });
            });

            const toggleAll = document.getElementById('toggle-all');
            toggleAll.addEventListener('click', function(e) {
                const sub_table_tbodies = Array.from(document.querySelectorAll('table.sub-table > tbody'));
                let shouldHide = sub_table_tbodies.some(element => element.classList.contains('show'));
                sub_table_tbodies.forEach( element => {
                    if( shouldHide ) {
                        element.classList.remove('show');
                    } else {
                        element.classList.add('show');
                    }
                });
            });
        });
        </script>
    </body>
    </html>`;

    return html;
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Please provide a URL as an argument.");
    process.exit(1);
}

const startUrl = args[0];
run(startUrl).catch(console.error);