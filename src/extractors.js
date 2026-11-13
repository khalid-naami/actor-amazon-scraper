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

/**
 * Clean numeric price from string
 */
export function parseAmazonPrice(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.replace(/,/g, '').match(/([0-9]+\.[0-9]{2}|[0-9]+)/);
    return match ? parseFloat(match[1]) : null;
}

/**
 * Clean star rating
 */
export function parseAmazonRating(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.replace(',', '.').match(/([0-5]\.[0-9]|[0-5])/);
    return match ? parseFloat(match[1]) : null;
}

/**
 * Clean review count
 */
export function parseAmazonReviewsCount(raw) {
    if (!raw || typeof raw !== 'string') return 0;
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
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
    if (!html) return null;

    // Title
    let title = null;
    const titleMatch = html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/i) || html.match(/id="title"[^>]*>([\s\S]*?)<\/h1>/i);
    if (titleMatch) {
        title = titleMatch[1].trim();
    }

    // Price
    let price = null;
    let listPrice = null;
    const priceSelectors = [
        /class="a-price aok-align-center[^"]*"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
        /id="corePriceDisplay_desktop_feature_div"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
        /id="corePrice_feature_div"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
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

    // Currency
    let currency = 'USD';
    if (domain.includes('.co.uk')) currency = 'GBP';
    else if (domain.includes('.de') || domain.includes('.fr') || domain.includes('.es') || domain.includes('.it')) currency = 'EUR';
    else if (domain.includes('.ca')) currency = 'CAD';
    else if (domain.includes('.co.jp')) currency = 'JPY';
    else if (domain.includes('.sa')) currency = 'SAR';
    else if (domain.includes('.ae')) currency = 'AED';

    // Rating & Reviews
    let rating = null;
    const ratingMatch = html.match(/<span class="a-icon-alt">([0-9.,]+ out of 5 stars|[0-9.,]+ von 5 Sternen|[0-9.,]+ sur 5 étoiles)<\/span>/i) ||
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
        stockMessage = availMatch[1].trim();
        const lower = stockMessage.toLowerCase();
        if (lower.includes('currently unavailable') || lower.includes('out of stock')) {
            inStock = false;
        }
    }

    // Seller & Fulfillment
    let seller = null;
    let fulfilledBy = null;
    const sellerMatch = html.match(/id="sellerProfileTriggerId"[^>]*>([^<]+)<\/a>/i) ||
                        html.match(/tabular-attribute-name="Sold by"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    if (sellerMatch) seller = sellerMatch[1].trim();

    const shipsMatch = html.match(/tabular-attribute-name="Ships from"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    if (shipsMatch) fulfilledBy = shipsMatch[1].trim();

    // Brand
    let brand = null;
    const brandMatch = html.match(/id="bylineInfo"[^>]*>([^<]+)<\/a>/i) ||
                       html.match(/class="po-brand"[^>]*>[\s\S]*?<span class="a-size-base po-break-word">([^<]+)<\/span>/i);
    if (brandMatch) {
        brand = brandMatch[1].replace(/^(Brand:\s*|Visit the\s*|Store)/i, '').trim();
    }

    // Best Sellers Rank (BSR)
    let bsr = null;
    const bsrMatch = html.match(/Best Sellers Rank:[^<]*<\/th>[\s\S]*?<td>([\s\S]*?)<\/td>/i) ||
                     html.match(/id="SalesRank"[^>]*>([\s\S]*?)<\/li>/i);
    if (bsrMatch) {
        bsr = bsrMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Coupon
    let coupon = null;
    const couponMatch = html.match(/class="couponBadge"[^>]*>([^<]+)<\/span>/i) ||
                        html.match(/label for="checkbox"[^>]*>([\s\S]*?)<\/label>/i);
    if (couponMatch) {
        coupon = couponMatch[1].replace(/\s+/g, ' ').trim();
    }

    // Prime
    const isPrime = html.includes('id="primePopoverContent"') || html.includes('class="a-icon a-icon-prime"');

    // Bullet Points / Features
    const features = [];
    const featureBlock = html.match(/id="feature-bullets"[^>]*>([\s\S]*?)<\/div>/i);
    if (featureBlock) {
        const bullets = [...featureBlock[1].matchAll(/<span class="a-list-item"[^>]*>([\s\S]*?)<\/span>/gi)];
        for (const b of bullets) {
            const text = b[1].replace(/<[^>]+>/g, '').trim();
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
 * Extract items from Amazon Search SERP HTML
 */
export function parseAmazonSearchHtml(html, domain = 'amazon.com') {
    const results = [];
    if (!html) return results;

    const cards = [...html.matchAll(/data-component-type="s-search-result"[^>]*data-asin="([A-Z0-9]{10})"[\s\S]*?(?=<div data-component-type="s-search-result"|$)/gi)];

    for (const card of cards) {
        const asin = card[1];
        const cardHtml = card[0];

        // Title & URL
        const titleMatch = cardHtml.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
        if (!titleMatch) continue;

        const urlPath = titleMatch[1];
        const title = titleMatch[2].trim();
        const fullUrl = urlPath.startsWith('http') ? urlPath : `https://www.${domain}${urlPath}`;

        // Price
        const priceMatch = cardHtml.match(/class="a-price"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i);
        const price = priceMatch ? parseAmazonPrice(priceMatch[1]) : null;

        // Rating
        const ratingMatch = cardHtml.match(/<span class="a-icon-alt">([0-9.,]+ out of 5 stars)<\/span>/i);
        const rating = ratingMatch ? parseAmazonRating(ratingMatch[1]) : null;

        // Image
        const imgMatch = cardHtml.match(/class="s-image"[^>]*src="([^"]+)"/i);
        const thumbnail = imgMatch ? imgMatch[1] : null;

        // Prime
        const isPrime = cardHtml.includes('aria-label="Amazon Prime"') || cardHtml.includes('a-icon-prime');

        let currency = 'USD';
        if (domain.includes('.co.uk')) currency = 'GBP';
        else if (domain.includes('.de') || domain.includes('.fr') || domain.includes('.es') || domain.includes('.it')) currency = 'EUR';
        else if (domain.includes('.ca')) currency = 'CAD';
        else if (domain.includes('.co.jp')) currency = 'JPY';
        else if (domain.includes('.sa')) currency = 'SAR';
        else if (domain.includes('.ae')) currency = 'AED';

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
