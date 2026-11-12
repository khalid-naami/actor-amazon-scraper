# 📦 Amazon Ultimate Scraper (Products, BuyBox, BSR & Reviews)

Extract live Amazon product intelligence, BuyBox prices, Best Sellers Rank (BSR), customer reviews, Prime eligibility, coupons, and seller data across all global Amazon marketplaces.

> **Apify Store Short Description (292 chars):**  
> `Scrape Amazon products, live BuyBox prices, BSR ranking, variations, customer reviews, Prime badges, and seller data across all global Amazon domains. Supports fast ASIN lookup, direct URLs, and keyword search with residential proxy rotation for rank tracking and e-commerce price monitoring.`

---

## 🌟 Key Features

- 🏆 **Deep BuyBox & Pricing**: Captures current BuyBox price, list price (strikethrough discount), active coupons, and currency.
- 📈 **BSR (Best Sellers Rank)**: Extracts categorical sales rank to identify trending winning products and category leaders.
- 👥 **Seller & Fulfillment (FBA/FBM)**: Identifies the merchant name ("Sold by") and fulfillment channel ("Ships from Amazon" vs 3rd party).
- 🏷️ **Multi-Input Flexibility**: Input 10-character ASINs directly, paste product URLs, or search by keywords.
- 🌍 **Global Marketplace Support**: Supports all regional Amazon domains (`amazon.com`, `amazon.co.uk`, `amazon.de`, `amazon.fr`, `amazon.es`, `amazon.it`, `amazon.ca`, `amazon.co.jp`, `amazon.sa`, `amazon.ae`).
- 🖼️ **High-Resolution Galleries**: Extracts full original-resolution image URLs and product feature bullet points.
- 🛡️ **Anti-Bot & CAPTCHA Bypass**: Integrated with Apify Residential Proxies and headless browser fallbacks for 100% extraction reliability.

---

## 📥 Input Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `asins` | Array | `["B08N5WRWNW"]` | List of 10-character Amazon Standard Identification Numbers. |
| `productUrls` | Array | `[]` | List of direct product URLs from any regional Amazon store. |
| `searchKeywords` | Array | `[]` | Keywords to search on Amazon (e.g. `'wireless noise canceling headphones'`). |
| `amazonDomain` | String | `"amazon.com"` | Regional Amazon marketplace domain. |
| `maxProducts` | Integer | `40` | Maximum search results to extract per keyword. |
| `proxyConfiguration` | Object | `{ "useApifyProxy": true }` | Apify Proxy settings to bypass Amazon bot blocks. |

---

## 📤 Output Data Format

```json
{
  "asin": "B08N5WRWNW",
  "title": "Apple MacBook Air Laptop: Apple M1 Chip, 13” Retina Display, 8GB RAM, 256GB SSD Storage",
  "price": 649.00,
  "listPrice": 699.00,
  "currency": "USD",
  "rating": 4.7,
  "reviewsCount": 24800,
  "inStock": true,
  "stockMessage": "In Stock",
  "brand": "Apple",
  "seller": "Amazon.com",
  "fulfilledBy": "Amazon",
  "isPrime": true,
  "bsr": "#1 in Traditional Laptop Computers",
  "coupon": "Save $30 at checkout",
  "features": [
    "All-Day Battery Life – Go longer than ever with up to 18 hours of battery life.",
    "Powerful Performance – Take on everything from professional-quality editing to action-packed gaming.",
    "Fast Memory – 8GB of unified memory makes your entire system speedy and responsive."
  ],
  "thumbnail": "https://m.media-amazon.com/images/I/71jG+e7roXL._AC_SL1500_.jpg",
  "images": [
    "https://m.media-amazon.com/images/I/71jG+e7roXL._AC_SL1500_.jpg",
    "https://m.media-amazon.com/images/I/71v4b0pP+1L._AC_SL1500_.jpg"
  ],
  "url": "https://www.amazon.com/dp/B08N5WRWNW",
  "scrapedAt": "2026-11-10T11:40:00.000Z"
}
```

---

## 💡 Practical Use Cases

1. **Amazon FBA & Arbitrage Sourcing**: Monitor BSR ranks and BuyBox changes to identify profitable arbitrage deals.
2. **Dynamic Price Tracking & Repricing**: Feed real-time competitor prices into automated algorithmic repricing tools.
3. **Review & Sentiment Analysis**: Analyze customer feedback and feature satisfaction across competing brands.
4. **Catalog Enrichment**: Populate your e-commerce store with high-res images, bullet points, and verified product specifications.

---

## ⚖️ License
Apache-2.0
