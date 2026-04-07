# n11.com Review Scraper

Node.js + Playwright scraper that collects product reviews from [n11.com](https://www.n11.com) in two phases: first gathering product IDs from category pages, then scraping reviews for each product. Designed for team-based parallel work with run tracking, resume, and failure recovery.

## Setup

```bash
npm install
```

Add category URLs to `categories.txt`, one per line:

```
https://www.n11.com/ev-tekstili
https://www.n11.com/mobilya
```

## Pipeline

### Phase 1 — Collect Product IDs

```bash
npm run scrape_product
```

Reads `categories.txt`, paginates through each category starting at page 2, and saves up to 1000 unique product IDs per category to `product_ids/<slug>_ids.json`.

- 3 concurrent workers
- 250ms + random jitter between requests
- Max 200 pages per category
- Stops on duplicate page detection
- Ctrl+C saves partial results

### Phase 2 — Collect Reviews

```bash
npm run scrape_review_def          # concurrency=3 (default)
npm run scrape_review_4            # concurrency=4
npm run scrape_review_5            # concurrency=5
```

Iterates through all product IDs in `product_ids/`, fetches reviews sorted by `RECENT`, and saves each product's reviews to `raw_data/<category>/<productId>_reviews.json`.

- 350ms + random jitter between requests
- Max 500 review pages per product
- Checkpoints every 5 pages (`.partial.json`)
- 3 retry attempts with 1.2s backoff
- Skips already-completed products
- Deduplicates reviews by ID

## Commands

| Script | Description |
|---|---|
| `npm run scrape_product` | Collect product IDs from categories |
| `npm run scrape_review_def` | Collect reviews (concurrency 3) |
| `npm run scrape_review_4` | Collect reviews (concurrency 4) |
| `npm run scrape_review_5` | Collect reviews (concurrency 5) |
| `npm run scrape_arda` | Run Arda's assigned categories |
| `npm run scrape_tugce` | Run Tugce's assigned categories |
| `npm run scrape_havvagul` | Run Havvagul's assigned categories |
| `npm run previous_scrapes` | List incomplete runs |
| `npm run all_scrapes` | List all runs |
| `npm run failed_scrapes` | Retry failed jobs |
| `npm run failed_scrapes_4` | Retry failed jobs (concurrency 4) |
| `npm run scrape_help` | Command reference (EN) |
| `npm run scrape_yardim` | Command reference (TR) |

## CLI Flags

```bash
node collection_auto_rawData.js [flags]
```

| Flag | Description |
|---|---|
| `--name=<runName>` | Name the run for tracking |
| `--resume-run=<runId>` | Resume a previous run |
| `--categories=<slug1,slug2>` | Filter to specific categories |
| `--products=<id1,id2>` | Filter to specific product IDs |
| `--concurrency=<n>` | Override worker count |
| `--failed-only` | Retry only failed jobs from latest failed list |
| `--failed-file=<path>` | Specify which failed jobs file to retry |
| `--team=<name>` | Run a team member's assigned categories |
| `--list-runs` | List incomplete runs |
| `--list-all-runs` | List all runs |

Flags can be combined:

```bash
node collection_auto_rawData.js --name=test --categories=mobilya,telefon --concurrency=4
node collection_auto_rawData.js --resume-run=test --concurrency=6
node collection_auto_rawData.js --failed-only --failed-file=logs/failed_jobs_latest.json
```

## Team Workflow

Three team members with pre-assigned categories for parallel work:

- **arda** — kitap, dekorasyon, telefon, ses-sistemleri, motosiklet, kadin-bakim, su-sporlari, yuz-ve-vucut-bakimi, cinsel-urunler, supermarket, beslenme, bilgisayar, video-oyun, bebek-giyim, bireysel-ve-takim-sporlari, emzirme, guzellik-salonu, kis-sporlari, televizyon-ve-ses-sistemleri
- **tugce** — kadin-giyim-aksesuar, outdoor, erkek-giyim-aksesuar, evcil-hayvan, yedek-parca, bisiklet, elektrikli-ev-aletleri, lastik-ve-jant, mutfak, spor-giyim, avcilik, erkek-bakim, mobilya, bebek-bezi, biberon, dugun-davet, fotograf, ilginc-akilli, tekne
- **havvagul** — parfum-ve-deodorant, saglik-ve-medikal, ev-tekstili, kirtasiye, beyaz-esya, yetiskin-hobi, muzik, sac-bakim, bebek-odasi, makyaj, cocuk-oyuncaklari, fitness, yapi-market, bebek-guvenlik, dijital-kodlar, film, hamile-giyim, oto-koltugu, yurutec, yasam-ve-etkinlik

Remaining unassigned categories are dynamically balanced to the lightest team.

```bash
npm run scrape_arda
npm run scrape_tugce
npm run scrape_havvagul

# Limit to first 5 categories
node collection_auto_rawData.js --team=arda 5
```

## Run Management

Each run generates:

- `logs/<runId>.log` — detailed log
- `logs/<runId>_summary.json` — completion stats (jobs queued, completed, failed, reviews collected)
- `logs/<runId>_failed_jobs.json` — failed jobs with errors
- `logs/failed_jobs_latest.json` — latest failed jobs (used by `--failed-only`)
- `logs/current_status.json` — live worker status during scraping

Resume an interrupted run:

```bash
node collection_auto_rawData.js --resume-run=<runId>
```

## Failure Handling

- Failed jobs are tracked in `logs/<runId>_failed_jobs.json`
- Partial results checkpoint every 5 pages as `<productId>_reviews.partial.json`
- Workers recycle browser pages after 5 consecutive errors
- Ctrl+C triggers graceful shutdown — saves all in-progress work

Retry all failed jobs:

```bash
npm run failed_scrapes
```

## Output Structure

```
product_ids/
  <category-slug>_ids.json       # Product IDs per category

raw_data/
  <category-slug>/
    <productId>_reviews.json     # Completed reviews
    <productId>_reviews.partial.json  # In-progress checkpoint

logs/
  <runId>.log
  <runId>_summary.json
  <runId>_failed_jobs.json
  current_status.json
  failed_jobs_latest.json
```

### Product IDs Format

```json
{
  "categoryUrl": "https://www.n11.com/ev-tekstili",
  "slug": "ev-tekstili",
  "collectedAt": "2026-04-05T...",
  "targetUniqueIds": 1000,
  "uniqueCount": 987,
  "ids": ["123456789", "234567890"],
  "partial": false
}
```

### Reviews Format

```json
{
  "categorySlug": "ev-tekstili",
  "productId": "123456789",
  "collectedAt": "2026-04-05T...",
  "pagesSeen": [1, 2, 3],
  "reviewCountUnique": 38,
  "noReviews": false,
  "reviews": [
    {
      "id": 5106277022,
      "contents": "Review text...",
      "title": "Review title",
      "scoreAsStar": 5,
      "maskedBuyerName": "username",
      "createdDate": "26/01/2026",
      "productTitle": "Product name",
      "sellerNickname": "seller-name",
      "helpfulVoteCount": 0,
      "imageFilePathList": []
    }
  ],
  "meta": {
    "sortOrder": "RECENT",
    "tag": "tümü",
    "itemsPerPage": 20,
    "pageCount": 3,
    "totalCount": 58
  }
}
```

## Browser Utilities

### listing_ids_capture.js

Paste into browser console to capture product listing IDs from network requests. Tracks page signatures to detect duplicate pages.

### manual.js

Browser-based manual review capture tool with two modes:

- **Passive** — records review data as you scroll through pages
- **Active** — `__n11Capture.autofetchCurrent()` fetches all review pages automatically

Supports snapshot export, memory management, and progress stats.

## Rate Limiting

| Phase | Base Delay | Jitter | Max Pages |
|---|---|---|---|
| Product IDs | 250ms | 0–120ms | 200/category |
| Reviews | 350ms | 0–120ms | 500/product |

Retry: 3 attempts, 1.2s delay between retries.
