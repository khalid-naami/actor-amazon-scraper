import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    detectAmazonPageState,
    domainToCurrency,
    extractAsin,
    parseAmazonPrice,
    parseAmazonProductHtml,
    parseAmazonRating,
    parseAmazonSearchHtml,
} from './extractors.js';

function sanitizeRecord(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj === 'number') return Number.isFinite(obj) ? obj : undefined;
    if (Array.isArray(obj)) {
        return obj.map(sanitizeRecord).filter((v) => v !== undefined);
    }
    if (typeof obj === 'object' && !(obj instanceof Date)) {
        const clean = {};
        for (const [k, v] of Object.entries(obj)) {
            const val = sanitizeRecord(v);
            if (val !== undefined) clean[k] = val;
        }
        return clean;
    }
    return obj;
}

function isProxyTransportError(errOrStatus) {
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return (
        errOrStatus === 597 ||
        errOrStatus === 407 ||
        errOrStatus === 502 ||
        /597|UPSTREAM407|407|Proxy responded with|tunneling socket|ERR_TUNNEL|ERR_PROXY|ECONNRESET/i.test(msg)
    );
}

await Actor.init();

let browser = null;
const diagnostics = [];
let totalProductsScraped = 0;
let inStockCount = 0;
let primeProductsCount = 0;

Actor.on('aborting', async () => {
    try {
        if (browser) await browser.close().catch(() => {});
        await Actor.setValue('OUTPUT', {
            totalProductsScraped,
            inStockCount,
            primeProductsCount,
            status: 'ABORTED',
            diagnostics,
            scrapedAt: new Date().toISOString(),
        });
    } catch {
        // Ignore cleanup errors on abort
    }
    await Actor.exit();
});

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
    let proxyEnabled = false;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                proxyUrl = await proxyConfig.newUrl();
                proxyEnabled = Boolean(proxyUrl);
                log.info('Proxy configured successfully');
            }
        } catch (proxyErr) {
            log.warning(`Proxy initialization failed (${proxyErr.message}); continuing with direct connection.`);
        }
    }

    const closeBrowser = async () => {
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
    };

    let proxyFailureCount = 0;
    const rotateOrDisableProxy = async (reason) => {
        if (!proxyEnabled || !isProxyTransportError(reason)) return false;
        proxyFailureCount++;
        await closeBrowser();
        if (proxyConfig && proxyFailureCount <= 1) {
            try {
                proxyUrl = await proxyConfig.newUrl();
                proxyEnabled = Boolean(proxyUrl);
                log.warning(`Rotated Apify Proxy session (attempt ${proxyFailureCount}) after upstream proxy transport error.`);
                return true;
            } catch {
                // Fall through to disable proxy
            }
        }
        proxyUrl = undefined;
        proxyEnabled = false;
        log.warning('Disabled failing proxy session (upstream tunnel error or target domain restricted on proxy tier); falling back to direct connection.');
        return true;
    };

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
                        server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
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

    const fetchHtmlWithHttp = async (url) => {
        let lastErr = null;
        // Up to 3 attempts: initial proxy -> rotated proxy -> direct connection fallback
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await gotScraping({
                    url,
                    proxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    },
                    timeout: { request: 25000 },
                    throwHttpErrors: false,
                });
                const body = response.body || '';
                const stateInfo = detectAmazonPageState(body, response.statusCode);
                if (stateInfo.state === 'antibot_challenge' && proxyEnabled && attempt === 1) {
                    proxyFailureCount++;
                    await closeBrowser();
                    if (proxyConfig) {
                        proxyUrl = await proxyConfig.newUrl().catch(() => undefined);
                        if (!proxyUrl) proxyEnabled = false;
                    }
                    continue;
                }
                return { html: body, statusCode: response.statusCode, ...stateInfo };
            } catch (err) {
                lastErr = err;
                const handled = await rotateOrDisableProxy(err);
                if (handled || attempt < 2) continue;
                break;
            }
        }
        return { html: '', statusCode: 0, state: 'http_error', reason: lastErr?.message || 'HTTP request failed' };
    };

    const fetchWithPlaywright = async (url, mode = 'product') => {
        // Up to 2 attempts: current proxy (or direct) -> direct fallback if ERR_TUNNEL / proxy error
        for (let attempt = 1; attempt <= 2; attempt++) {
            let page = null;
            let context = null;
            try {
                const b = await getBrowser();
                context = await b.newContext({
                    locale: 'en-US',
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                });
                page = await context.newPage();
                await page.route('**/*.{mp4,webm,avi,woff,woff2}', (route) => route.abort());

                const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
                const statusCode = response ? response.status() : 200;

                const waitSel = mode === 'search'
                    ? '[data-component-type="s-search-result"], form[action*="validateCaptcha"]'
                    : '#productTitle, #title, form[action*="validateCaptcha"]';
                await page.waitForSelector(waitSel, { timeout: 8000 }).catch(() => {});

                const html = await page.content();
                const domFallback = mode === 'search'
                    ? await page.evaluate(() => {
                        const items = [];
                        document.querySelectorAll('[data-component-type="s-search-result"][data-asin]').forEach((el) => {
                            const asin = el.getAttribute('data-asin');
                            const h2 = el.querySelector('h2');
                            const title = h2 ? h2.innerText.trim() : '';
                            const linkEl = el.querySelector('a[href*="/dp/"]') || el.querySelector('h2 a');
                            const priceEl = el.querySelector('.a-price .a-offscreen');
                            const ratingEl = el.querySelector('.a-icon-alt');
                            const imgEl = el.querySelector('img.s-image');
                            const isPrime = Boolean(el.querySelector('.a-icon-prime, [aria-label="Amazon Prime"]'));
                            if (asin && title) {
                                items.push({
                                    asin,
                                    title,
                                    href: linkEl ? linkEl.getAttribute('href') : `/dp/${asin}`,
                                    priceText: priceEl ? priceEl.textContent.trim() : null,
                                    ratingText: ratingEl ? ratingEl.textContent.trim() : null,
                                    thumbnail: imgEl ? imgEl.src : null,
                                    isPrime,
                                });
                            }
                        });
                        return items;
                    }).catch(() => [])
                    : [];

                await page.close();
                await context.close();

                const stateInfo = detectAmazonPageState(html, statusCode);
                return { html, statusCode, domFallback, ...stateInfo };
            } catch (bErr) {
                if (page) await page.close().catch(() => {});
                if (context) await context.close().catch(() => {});
                const handled = await rotateOrDisableProxy(bErr);
                log.warning(`Browser fallback error (${attempt}/2): ${bErr.message}`);
                if (handled && attempt === 1) continue;
                return { html: '', statusCode: 0, domFallback: [], state: 'browser_error', reason: bErr.message };
            }
        }
        return { html: '', statusCode: 0, domFallback: [], state: 'browser_error', reason: 'Playwright attempts exhausted' };
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

    const effectiveSearchKeywords = Array.isArray(searchKeywords)
        ? searchKeywords.filter((k) => typeof k === 'string' && k.trim())
        : [];

    if (targetAsins.size === 0 && effectiveSearchKeywords.length === 0) {
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
            const httpRes = await fetchHtmlWithHttp(productUrl);
            if (httpRes.state === 'ok') {
                product = parseAmazonProductHtml(httpRes.html, asin, amazonDomain);
            }

            let finalState = httpRes.state;
            let finalReason = httpRes.reason;

            if ((!product || !product.title) && httpRes.state !== 'unavailable') {
                log.info(`Using browser fallback for ASIN: ${asin} (HTTP state=${httpRes.state})...`);
                const pwRes = await fetchWithPlaywright(productUrl, 'product');
                finalState = pwRes.state;
                finalReason = pwRes.reason;
                if (pwRes.state === 'ok') {
                    product = parseAmazonProductHtml(pwRes.html, asin, amazonDomain);
                }
            }

            if (product && product.title) {
                await Actor.pushData(sanitizeRecord(product));
                totalProductsScraped++;
                if (product.inStock) inStockCount++;
                if (product.isPrime) primeProductsCount++;
                diagnostics.push({ target: asin, mode: 'asin', state: 'ok', itemsExtracted: 1 });
                log.info(`[${totalProductsScraped}] Scraped ASIN ${asin}: "${product.title.slice(0, 45)}..." | Price: ${product.currency} ${product.price ?? 'N/A'}`);
            } else {
                diagnostics.push({ target: asin, mode: 'asin', state: finalState, reason: finalReason, itemsExtracted: 0 });
                log.warning(`Could not extract valid data for ASIN: ${asin} (state=${finalState}: ${finalReason})`);
            }

            await new Promise((r) => setTimeout(r, 1200));
        }
    }

    // 2. Process Search Keywords
    if (effectiveSearchKeywords.length > 0) {
        log.info(`Searching Amazon for ${effectiveSearchKeywords.length} keyword(s)...`);

        for (const keyword of effectiveSearchKeywords) {
            log.info(`Searching Amazon for: "${keyword}" (max: ${maxProducts})`);
            const searchUrl = `https://www.${amazonDomain}/s?k=${encodeURIComponent(keyword)}`;

            try {
                const httpRes = await fetchHtmlWithHttp(searchUrl);
                let results = httpRes.state === 'ok' ? parseAmazonSearchHtml(httpRes.html, amazonDomain) : [];
                let finalState = httpRes.state;
                let finalReason = httpRes.reason;

                if (results.length === 0) {
                    log.info(`Using browser fallback for Amazon search: "${keyword}" (HTTP state=${httpRes.state})...`);
                    const pwRes = await fetchWithPlaywright(searchUrl, 'search');
                    finalState = pwRes.state;
                    finalReason = pwRes.reason;
                    if (pwRes.state === 'ok') {
                        results = parseAmazonSearchHtml(pwRes.html, amazonDomain);
                        if (results.length === 0 && pwRes.domFallback.length > 0) {
                            const currency = domainToCurrency(amazonDomain);
                            results = pwRes.domFallback.map((d) => ({
                                asin: d.asin,
                                title: d.title,
                                price: parseAmazonPrice(d.priceText),
                                currency,
                                rating: parseAmazonRating(d.ratingText),
                                thumbnail: d.thumbnail,
                                isPrime: d.isPrime,
                                url: (d.href.startsWith('http') ? d.href : `https://www.${amazonDomain}${d.href}`).split('?')[0],
                                scrapedAt: new Date().toISOString(),
                            }));
                        }
                    }
                }

                const sliced = results.slice(0, maxProducts);
                for (const item of sliced) {
                    item.searchKeyword = keyword;
                    await Actor.pushData(sanitizeRecord(item));
                    totalProductsScraped++;
                    if (item.isPrime) primeProductsCount++;
                }

                diagnostics.push({
                    target: keyword,
                    mode: 'search',
                    state: sliced.length > 0 ? 'ok' : finalState,
                    reason: sliced.length > 0 ? 'OK' : finalReason,
                    itemsExtracted: sliced.length,
                });

                if (sliced.length > 0) {
                    log.info(`Extracted ${sliced.length} search results for "${keyword}"`);
                } else {
                    log.warning(`Extracted 0 search results for "${keyword}" (state=${finalState}: ${finalReason})`);
                }
            } catch (searchErr) {
                diagnostics.push({ target: keyword, mode: 'search', state: 'error', reason: searchErr.message, itemsExtracted: 0 });
                log.error(`Error searching Amazon for "${keyword}": ${searchErr.message}`);
            }
        }
    }

    await closeBrowser();

    const summary = {
        totalProductsScraped,
        inStockCount,
        primeProductsCount,
        domain: amazonDomain,
        status: totalProductsScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        diagnostics,
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    if (totalProductsScraped === 0) {
        const lastDiag = diagnostics[diagnostics.length - 1];
        const hint = lastDiag?.reason ? ` Last diagnostic: ${lastDiag.state} (${lastDiag.reason}).` : '';
        await Actor.fail(`Extracted 0 products.${hint} Note: Apify Free Datacenter Proxy restricts amazon.com — use RESIDENTIAL proxy group or direct IP.`);
    }
    log.info(`Amazon Scraping finished successfully! Total items: ${totalProductsScraped}`);
} catch (err) {
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await closeBrowser().catch(() => {});
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message, diagnostics });
    await Actor.fail(err.message);
} finally {
    await Actor.exit();
}
