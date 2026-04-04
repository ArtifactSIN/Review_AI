# Review Scraper

This folder contains the tooling that collects product reviews, walks through
pagination, and saves the results in JSONL/CSV form for later analysis. The
project includes a tiny synthetic catalogue so the pipeline can be exercised
without touching the network, plus CLI switches for real-world runs.

## Capabilities
- Pagination limits and polite delays per product.
- Machine-readable outputs: one JSONL per product and aggregate CSV/JSONL files.

Artifacts will appear in `data/sample_run/raw/` (per-item JSONL files) and
`data/sample_run/aggregate/` (combined corpus and index CSV).

## Scraping a Live Page
1. Inspect the target site with browser dev tools and note the CSS selectors for
   review cards, titles, ratings, etc.
2. Save those selectors in a JSON file, for example:

```jsonc
{
  "review_container": ".review",
  "title": ".review__title",
  "body": ".review__text",
  "rating": ".review__rating span",
  "author": ".review__author",
  "date": "time",
  "next_page": "a.next",
  "item_name": "h1.product-name"
}
```

Keep the target site's policies in mind: obey robots.txt, rate limits, and any
legal restrictions. Extend `demo_scraper.py` with authentication headers or
browser automation if a site requires them.
