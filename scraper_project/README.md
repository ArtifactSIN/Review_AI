# Review Scraper

This folder contains the tooling that collects product reviews, walks through
pagination, and saves the results in JSONL/CSV form for later analysis. The
project includes a tiny synthetic catalogue so the pipeline can be exercised
without touching the network, plus CLI switches for real-world runs.

## Capabilities
- Configurable CSS selectors for every review field.
- Pagination limits and polite delays per product.
- Optional embedded HTML snapshots for offline runs.
- Machine-readable outputs: one JSONL per product and aggregate CSV/JSONL files.

## Requirements
- Python 3.10 or newer.
- Dependencies listed in `requirements.txt`:

```bash
pip3 install -r requirements.txt
```

## First Run (sample data)

```bash
python3 scraper/demo_scraper.py \
  --config scraper/configs/sample_config.json \
  --use-sample-data \
  --output-dir data/sample_run
```

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

3. Run the scraper against one or more URLs (repeat `--product-url` to add more
   items):

```bash
python3 scraper/demo_scraper.py \
  --product-url https://example.com/widget/reviews \
  --selector-config /path/to/selectors.json \
  --max-pages 3 \
  --output-dir data/widget_run
```

When at least one URL uses `http` or `https`, the script automatically switches
to real network requests. Use the `--use-sample-data` flag only when every URL
starts with `sample://`.

## CLI Reference
- `--config`: Load a full JSON config (URLs, selectors, limits, etc.).
- `--product-url`: Add a single product page from the command line.
- `--selector-config`: Provide only the selector overrides you want to change.
- `--max-pages`: Limit pagination depth per product.
- `--output-dir`: Override where JSON/CSV files are written.
- `--use-sample-data`: Force usage of bundled HTML files.

Keep the target site's policies in mind: obey robots.txt, rate limits, and any
legal restrictions. Extend `demo_scraper.py` with authentication headers or
browser automation if a site requires them.
