/**
 * Amazon Product & Search Extraction Handlers
 */

/**
 * Extract 10-character Amazon ASIN from URL or string
 */
export function extractAsin(input) {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (/^[A-Z0-9]{10}$/i.test(trimmed)) {
        return trimmed.toUpperCase();
    }
    const match = trimmed.match(/(?:\/dp\/|\/gp\/product\/|\/d\/|\/ASIN\/)([A-Z0-9]{10})/i);
    return match ? match[1].toUpperCase() : null;
}

function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return str;
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

export function detectAmazonPageState(html, statusCode = 200) {
    if (statusCode === 404) {
        return { state: 'unavailable', reason: 'HTTP 404 (Product not found on this marketplace)' };
    }
    if (statusCode === 503 || statusCode === 429 || statusCode === 403) {
        return { state: 'antibot_challenge', reason: `HTTP ${statusCode} Amazon anti-bot throttle/service block` };
    }
    if (statusCode >= 400) {
        return { state: 'http_error', reason: `HTTP ${statusCode}` };
    }
    if (!html || typeof html !== 'string' || html.trim().length < 20) {
        return { state: 'empty_body', reason: 'Empty or truncated HTML response' };
    }
    const lower = html.toLowerCase();
    if (
        lower.includes('api-services-support@amazon.com') ||
        lower.includes('enter the characters you see below') ||
        lower.includes('type the characters you see in this image') ||
        lower.includes('validatecaptcha') ||
        lower.includes('opfcaptcha')
    ) {
        return {
            state: 'antibot_challenge',
            reason: 'Amazon CAPTCHA / Robot Check gate detected; enable Apify RESIDENTIAL proxy',
        };
    }
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : '';
    if (/page not found/i.test(pageTitle) || lower.includes("we couldn't find that page")) {
        return { state: 'unavailable', reason: pageTitle || 'Page Not Found' };
    }
    if (html.trim().length < 200) {
        return { state: 'empty_body', reason: 'Empty or truncated HTML response' };
    }
    return { state: 'ok', reason: pageTitle || 'OK' };
}

/**
 * Clean numeric price from string
 */
export function parseAmazonPrice(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.replace(/,/g, '').match(/([0-9]+\.[0-9]{2}|[0-9]+)/);
    if (!match) return null;
    const num = parseFloat(match[1]);
    return Number.isFinite(num) ? num : null;
}

/**
 * Clean star rating
 */
export function parseAmazonRating(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.replace(',', '.').match(/([0-5]\.[0-9]|[0-5])/);
    if (!match) return null;
    const num = parseFloat(match[1]);
    return Number.isFinite(num) ? num : null;
}

/**
 * Clean review count
 */
export function parseAmazonReviewsCount(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : 0;
    if (!raw || typeof raw !== 'string') return 0;
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
}

export function domainToCurrency(domain = 'amazon.com') {
    if (domain.includes('.co.uk')) return 'GBP';
    if (domain.includes('.de') || domain.includes('.fr') || domain.includes('.es') || domain.includes('.it')) return 'EUR';
    if (domain.includes('.ca')) return 'CAD';
    if (domain.includes('.co.jp')) return 'JPY';
    if (domain.includes('.sa')) return 'SAR';
    if (domain.includes('.ae')) return 'AED';
    return 'USD';
}

/**
 * Extract high-resolution image gallery from landing image data attribute
 */
export function parseAmazonGallery(html) {
    const images = [];
    try {
        // Method A: Dynamic image map on #landingImage
        const dynamicMatch = html.match(/data-a-dynamic-image="([^"]+)"/);
        if (dynamicMatch) {
            const decoded = dynamicMatch[1].replace(/&quot;/g, '"');
            const map = JSON.parse(decoded);
            images.push(...Object.keys(map));
        }

        // Method B: colorImages script data
        if (images.length === 0) {
            const colorMatch = html.match(/'colorImages':\s*\{\s*'initial':\s*(\[[\s\S]*?\])\s*\},/);
            if (colorMatch) {
                const arr = JSON.parse(colorMatch[1]);
                for (const item of arr) {
                    if (item.hiRes) images.push(item.hiRes);
                    else if (item.large) images.push(item.large);
                }
            }
        }
    } catch {
        // Fallback
    }
    return [...new Set(images)];
}

/**
 * Extract full product details from Amazon Product HTML
 */
export function parseAmazonProductHtml(html, asin, domain = 'amazon.com') {
    if (!html || typeof html !== 'string') return null;

    const stateCheck = detectAmazonPageState(html, 200);
    if (stateCheck.state === 'antibot_challenge' || stateCheck.state === 'unavailable') {
        return null;
    }

    // Title
    let title = null;
    const titleMatch =
        html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/i) ||
        html.match(/id="title"[^>]*>([\s\S]*?)<\/h1>/i);
    if (titleMatch) {
        title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ''));
    }

    // Price
    let price = null;
    let listPrice = null;
    const priceSelectors = [
        /class="a-price aok-align-center[^"]*"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
        /id="corePriceDisplay_desktop_feature_div"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
        /id="corePrice_feature_div"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
        /class="[^"]*(?:apexPriceToPay|reinventPricePriceToPayMargin)[^"]*"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
        /id="price_inside_buybox"[^>]*>([^<]+)<\/span>/i,
        /id="priceblock_ourprice"[^>]*>([^<]+)<\/span>/i,
    ];

    for (const regex of priceSelectors) {
        const match = html.match(regex);
        if (match) {
            price = parseAmazonPrice(match[1]);
            if (price !== null) break;
        }
    }

    // List Price (strikethrough)
    const listPriceMatch = html.match(/class="a-price a-text-price[^"]*"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i);
    if (listPriceMatch) {
        listPrice = parseAmazonPrice(listPriceMatch[1]);
    }

    const currency = domainToCurrency(domain);

    // Rating & Reviews
    let rating = null;
    const ratingMatch =
        html.match(/<span class="a-icon-alt">([0-9.,]+ out of 5 stars|[0-9.,]+ von 5 Sternen|[0-9.,]+ sur 5 étoiles)<\/span>/i) ||
        html.match(/id="acrPopover"[^>]*title="([^"]+)"/i);
    if (ratingMatch) {
        rating = parseAmazonRating(ratingMatch[1]);
    }

    let reviewsCount = 0;
    const reviewsMatch = html.match(/id="acrCustomerReviewText"[^>]*>([^<]+)<\/span>/i);
    if (reviewsMatch) {
        reviewsCount = parseAmazonReviewsCount(reviewsMatch[1]);
    }

    // Availability / In Stock
    let inStock = true;
    let stockMessage = 'In Stock';
    const availMatch = html.match(/id="availability"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    if (availMatch) {
        stockMessage = decodeHtmlEntities(availMatch[1].replace(/<[^>]+>/g, '')) || 'In Stock';
        const lower = stockMessage.toLowerCase();
        if (lower.includes('currently unavailable') || lower.includes('out of stock')) {
            inStock = false;
        }
    }

    // Seller & Fulfillment
    let seller = null;
    let fulfilledBy = null;
    const sellerMatch =
        html.match(/id="sellerProfileTriggerId"[^>]*>([^<]+)<\/a>/i) ||
        html.match(/tabular-attribute-name="Sold by"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    if (sellerMatch) seller = decodeHtmlEntities(sellerMatch[1].replace(/<[^>]+>/g, ''));

    const shipsMatch = html.match(/tabular-attribute-name="Ships from"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    if (shipsMatch) fulfilledBy = decodeHtmlEntities(shipsMatch[1].replace(/<[^>]+>/g, ''));

    // Brand
    let brand = null;
    const brandMatch =
        html.match(/id="bylineInfo"[^>]*>([^<]+)<\/a>/i) ||
        html.match(/class="po-brand"[^>]*>[\s\S]*?<span class="a-size-base po-break-word">([^<]+)<\/span>/i);
    if (brandMatch) {
        brand = decodeHtmlEntities(brandMatch[1]).replace(/^(Brand:\s*|Visit the\s*|Store)/i, '').trim();
    }

    // Best Sellers Rank (BSR)
    let bsr = null;
    const bsrMatch =
        html.match(/Best Sellers Rank:[^<]*<\/th>[\s\S]*?<td>([\s\S]*?)<\/td>/i) ||
        html.match(/id="SalesRank"[^>]*>([\s\S]*?)<\/li>/i);
    if (bsrMatch) {
        bsr = decodeHtmlEntities(bsrMatch[1].replace(/<[^>]+>/g, ' '));
    }

    // Coupon
    let coupon = null;
    const couponMatch =
        html.match(/class="couponBadge"[^>]*>([^<]+)<\/span>/i) ||
        html.match(/label for="checkbox"[^>]*>([\s\S]*?)<\/label>/i);
    if (couponMatch) {
        coupon = decodeHtmlEntities(couponMatch[1].replace(/<[^>]+>/g, ' '));
    }

    // Prime
    const isPrime = html.includes('id="primePopoverContent"') || html.includes('class="a-icon a-icon-prime"');

    // Bullet Points / Features
    const features = [];
    const featureBlock = html.match(/id="feature-bullets"[^>]*>([\s\S]*?)<\/div>/i);
    if (featureBlock) {
        const bullets = [...featureBlock[1].matchAll(/<span class="a-list-item"[^>]*>([\s\S]*?)<\/span>/gi)];
        for (const b of bullets) {
            const text = decodeHtmlEntities(b[1].replace(/<[^>]+>/g, ''));
            if (text && !text.includes('Make sure this fits')) {
                features.push(text);
            }
        }
    }

    // Images
    const images = parseAmazonGallery(html);
    const thumbnail = images[0] || null;

    // Canonical URL
    const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/i);
    const canonicalUrl = canonicalMatch ? canonicalMatch[1] : `https://www.${domain}/dp/${asin}`;

    if (!title) return null;

    return {
        asin,
        title,
        price,
        listPrice,
        currency,
        rating,
        reviewsCount,
        inStock,
        stockMessage,
        brand,
        seller,
        fulfilledBy,
        isPrime,
        bsr,
        coupon,
        features: features.length > 0 ? features : null,
        thumbnail,
        images,
        url: canonicalUrl,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Extract items from Amazon Search SERP HTML (supports both <a><h2><span> and <h2><a><span> layouts)
 */
export function parseAmazonSearchHtml(html, domain = 'amazon.com') {
    const results = [];
    if (!html || typeof html !== 'string') return results;

    const stateCheck = detectAmazonPageState(html, 200);
    if (stateCheck.state === 'antibot_challenge') return results;

    const cards = [...html.matchAll(/data-component-type="s-search-result"[^>]*data-asin="([A-Z0-9]{10})"[\s\S]*?(?=<div[^>]*data-component-type="s-search-result"|$)/gi)];
    const currency = domainToCurrency(domain);

    for (const card of cards) {
        const asin = card[1].toUpperCase();
        const cardHtml = card[0];

        // Title across both <h2 ...><a><span>Title</span></a></h2> and <a><h2 ...><span>Title</span></h2></a>
        const h2Match = cardHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
        const rawTitle = h2Match ? h2Match[1].replace(/<[^>]+>/g, ' ') : '';
        const title = decodeHtmlEntities(rawTitle);
        if (!title) continue;

        const hrefMatch =
            cardHtml.match(/<a[^>]*class="[^"]*a-link-normal[^"]*"[^>]*href="([^"]*\/dp\/[A-Z0-9]{10}[^"]*)"/i) ||
            cardHtml.match(/<a[^>]*href="([^"]*(?:\/dp\/|\/sspa\/click)[^"]*)"/i);
        const urlPath = hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : `/dp/${asin}`;
        const fullUrl = urlPath.startsWith('http') ? urlPath : `https://www.${domain}${urlPath}`;

        const priceMatch = cardHtml.match(/class="a-price"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i);
        const price = priceMatch ? parseAmazonPrice(priceMatch[1]) : null;

        const ratingMatch = cardHtml.match(/<span class="a-icon-alt">([0-9.,]+ out of 5 stars|[0-9.,]+ von 5 Sternen|[0-9.,]+ sur 5 étoiles)<\/span>/i);
        const rating = ratingMatch ? parseAmazonRating(ratingMatch[1]) : null;

        const imgMatch = cardHtml.match(/class="s-image"[^>]*src="([^"]+)"/i);
        const thumbnail = imgMatch ? imgMatch[1] : null;

        const isPrime = cardHtml.includes('aria-label="Amazon Prime"') || cardHtml.includes('a-icon-prime');

        results.push({
            asin,
            title,
            price,
            currency,
            rating,
            thumbnail,
            isPrime,
            url: fullUrl.split('?')[0],
            scrapedAt: new Date().toISOString(),
        });
    }

    return results;
}
