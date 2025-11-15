# Review Scraper Demo

A configurable scraper that harvests product reviews across multiple detail pages and stores them in a machine-learning-friendly layout. It ships with synthetic HTML so you can run the end-to-end pipeline without hitting live websites.

## Features
- Per-product pagination with pluggable CSS selectors.
- Optional embedded sample data for offline testing.
- Normalized outputs: JSONL per item plus aggregate JSONL and CSV index.
- CLI configuration via flags or JSON config file.

## Requirements
- Python 3.10+
- `requests` and `beautifulsoup4` (install via `pip install -r requirements.txt`).

## Quick Start
1. Install dependencies:

```bash
pip install -r requirements.txt
```

2. Run the scraper against the embedded sample pages:

```bash
python scraper/demo_scraper.py --config scraper/configs/sample_config.json --use-sample-data --output-dir data/sample_run
```

3. Inspect the generated files under `data/sample_run`:
- `raw/<item_id>.jsonl`: review records for a single product.
- `aggregate/all_reviews.jsonl`: concatenated corpus.
- `aggregate/review_index.csv`: item-level counts for bookkeeping.

## Customizing for a Real Site
- Copy `scraper/configs/sample_config.json` and update `product_urls` with real product review URLs.
- Adjust selectors so they match the site markup (use browser dev tools to inspect). Each selector supports any CSS expression recognized by BeautifulSoup.
- Respect the target site's robots.txt, rate limits, and Terms of Service. Increase `delay_seconds` or add your own retry/backoff to stay polite.
- Remove the `--use-sample-data` flag and ensure `product_urls` use `http(s)` when scraping real pages.

## CLI Flags
- `--config`: Path to JSON config (defaults to the embedded sample config if omitted).
- `--output-dir`: Overrides the config output path.
- `--use-sample-data`: Forces the scraper to pull HTML from the embedded dataset. Useful for tests.

## JSON Config Schema
```jsonc
{
  "product_urls": ["https://example.com/item-a/reviews", "https://example.com/item-b/reviews"],
  "selectors": {
    "review_container": ".review-card",
    "title": ".review-title",
    "body": ".review-body",
    "rating": ".review-rating",
    "author": ".review-author",
    "date": ".review-date",
    "next_page": "a.next",
    "item_name": "h1.product-title"
  },
  "max_pages_per_product": 5,
  "delay_seconds": 1.0,
  "output_dir": "../data/reviews",
  "user_agent": "Mozilla/5.0 ..."
}
```

Feel free to extend `scraper/demo_scraper.py` with custom storage backends (e.g., database writers) or additional metadata hooks for downstream ML experiments.
