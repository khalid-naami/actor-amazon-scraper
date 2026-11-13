import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    extractAsin,
    parseAmazonProductHtml,
    parseAmazonSearchHtml,
} from './extractors.js';

function sanitizeRecord(obj) {
    if (Array.isArray(obj)) return obj.map((item) => sanitizeRecord(item));
    if (!obj || typeof obj !== 'object') return obj;
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) {
            clean[k] = Array.isArray(v)
                ? v.map((item) => (item && typeof item === 'object' ? sanitizeRecord(item) : item))
                : v && typeof v === 'object' && !(v instanceof Date)
                    ? sanitizeRecord(v)
                    : v;
        }
    }
    return clean;
}

function isProxyTransportError(errOrStatus) {
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return errOrStatus === 597 || errOrStatus === 407 || /597|UPSTREAM407|407|Proxy responded with|tunneling socket/i.test(msg);
}

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        asins = [],
        productUrls = [],
        searchKeywords = [],
        amazonDomain = 'amazon.com',
        maxProducts = 40,
        proxyConfiguration,
    } = input;

    log.info(`Starting Amazon Ultimate Scraper for domain: ${amazonDomain}...`);

    // Setup Proxy
    let proxyConfig = null;
    let proxyUrl = undefined;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                proxyUrl = await proxyConfig.newUrl();
                log.info('Proxy configured successfully');
            }
        } catch (proxyErr) {
            log.warning(`Proxy initialization failed (${proxyErr.message}); continuing with direct connection.`);
        }
    }

    const rotateOrDisableProxy = async (err) => {
        if (!isProxyTransportError(err)) return;
        if (proxyConfig) {
            try {
                proxyUrl = await proxyConfig.newUrl();
                log.warning('Rotated Apify Proxy session after upstream proxy transport error.');
                return;
            } catch {
                // Fall through to disable proxy
            }
        }
        proxyUrl = undefined;
        log.warning('Disabled broken proxy session; falling back to direct connection.');
    };

    let totalProductsScraped = 0;
    let inStockCount = 0;
    let primeProductsCount = 0;

    // Helper: Browser instance for anti-bot fallback
    let browser = null;
    const getBrowser = async () => {
        if (!browser) {
            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                ],
            };
            if (proxyUrl) {
                try {
                    const u = new URL(proxyUrl);
                    launchOptions.proxy = {
                        server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
                        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
                        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
                    };
                } catch {
                    launchOptions.proxy = { server: proxyUrl };
                }
            }
            browser = await chromium.launch(launchOptions);
        }
        return browser;
    };

    // 1. Collect target ASINs from asins and productUrls
    const targetAsins = new Set();

    if (Array.isArray(asins)) {
        for (const a of asins) {
            const asin = extractAsin(a);
            if (asin) targetAsins.add(asin);
        }
    }

    if (Array.isArray(productUrls)) {
        for (const u of productUrls) {
            const asin = extractAsin(typeof u === 'string' ? u : u?.url);
            if (asin) targetAsins.add(asin);
        }
    }

    if (targetAsins.size === 0 && (!Array.isArray(searchKeywords) || searchKeywords.length === 0)) {
        targetAsins.add('B08N5WRWNW');
        targetAsins.add('B09XS7JWHH');
    }

    // Process Direct ASINs
    if (targetAsins.size > 0) {
        log.info(`Scraping ${targetAsins.size} specific Amazon ASINs...`);

        for (const asin of targetAsins) {
            const productUrl = `https://www.${amazonDomain}/dp/${asin}`;
            log.info(`Fetching Amazon product: ${productUrl}`);

            let product = null;

            // Strategy A: gotScraping
            try {
                const response = await gotScraping({
                    url: productUrl,
                    proxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    },
                    timeout: { request: 25000 },
                });

                const html = response.body;
                if (!html.includes('api-services-support@amazon.com') && !html.includes('Enter the characters you see below')) {
                    product = parseAmazonProductHtml(html, asin, amazonDomain);
                }
            } catch (gotErr) {
                await rotateOrDisableProxy(gotErr);
                log.debug(`gotScraping failed for ${asin}: ${gotErr.message}`);
            }

            // Strategy B: Browser fallback if blocked
            if (!product || !product.title) {
                try {
                    log.info(`Using browser fallback for ASIN: ${asin}...`);
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(2000);

                    const html = await page.content();
                    product = parseAmazonProductHtml(html, asin, amazonDomain);
                    await page.close();
                } catch (bErr) {
                    await rotateOrDisableProxy(bErr);
                    log.warning(`Browser fallback error for ${asin}: ${bErr.message}`);
                }
            }

            if (product && product.title) {
                await Actor.pushData(sanitizeRecord(product));
                totalProductsScraped++;
                if (product.inStock) inStockCount++;
                if (product.isPrime) primeProductsCount++;

                log.info(`[${totalProductsScraped}] Scraped ASIN ${asin}: "${product.title.slice(0, 45)}..." | Price: ${product.currency} ${product.price ?? 'N/A'}`);
            } else {
                log.warning(`Could not extract valid data for ASIN: ${asin}`);
            }

            // Polite delay between requests
            await new Promise((r) => setTimeout(r, 1500));
        }
    }

    // 2. Process Search Keywords
    if (Array.isArray(searchKeywords) && searchKeywords.length > 0) {
        log.info(`Searching Amazon for ${searchKeywords.length} keywords...`);

        for (const keyword of searchKeywords) {
            log.info(`Searching Amazon for: "${keyword}" (max: ${maxProducts})`);
            const searchUrl = `https://www.${amazonDomain}/s?k=${encodeURIComponent(keyword)}`;

            try {
                let html = null;

                try {
                    const response = await gotScraping({
                        url: searchUrl,
                        proxyUrl,
                        headers: {
                            'accept-language': 'en-US,en;q=0.9',
                            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                        },
                        timeout: { request: 30000 },
                    });
                    html = response.body;
                } catch (err) {
                    await rotateOrDisableProxy(err);
                    log.debug(`Direct search request failed: ${err.message}`);
                }

                if (!html || html.includes('api-services-support@amazon.com') || html.includes('Enter the characters you see below')) {
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(2000);
                    html = await page.content();
                    await page.close();
                }

                const results = parseAmazonSearchHtml(html, amazonDomain);
                const sliced = results.slice(0, maxProducts);

                for (const item of sliced) {
                    item.searchKeyword = keyword;
                    await Actor.pushData(sanitizeRecord(item));
                    totalProductsScraped++;
                    if (item.isPrime) primeProductsCount++;
                }

                log.info(`Extracted ${sliced.length} search results for "${keyword}"`);

            } catch (searchErr) {
                log.error(`Error searching Amazon for "${keyword}": ${searchErr.message}`);
            }
        }
    }

    if (browser) {
        await browser.close();
    }

    // Save final executive summary
    const summary = {
        totalProductsScraped,
        inStockCount,
        primeProductsCount,
        domain: amazonDomain,
        status: totalProductsScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    if (totalProductsScraped === 0) {
        await Actor.fail('Extracted 0 products. Verify target URLs, keywords, or proxy configuration.');
    }
    log.info(`Amazon Scraping finished successfully! Total items: ${totalProductsScraped}`);

} catch (err) {
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message });
    await Actor.fail(err.message);
} finally {
    await Actor.exit();
}
