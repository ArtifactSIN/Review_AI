# Review Scraper — Project Context

## Purpose
Scrapes product reviews for a fake-review detection ML pipeline.
Stack: Node.js + Playwright (CommonJS). No TypeScript, no build step.

## Project Structure

```
scraper_project/
├── n11/          # n11.com scraper (active, data collected)
├── trendyol/     # trendyol.com scraper (in progress)
├── node_modules/ # shared — both scrapers resolve up to here
└── package.json  # npm scripts for both platforms
```

---

## n11 Scraper (`n11/`)

### Key Scripts

| Script | Phase | What it does |
|---|---|---|
| `n11/collect_category_ids.js` | 1 | Scrapes product IDs from category pages → `n11/product_ids/` |
| `n11/collection_auto_rawData.js` | 2 | Scrapes reviews for each product ID → `n11/raw_data/` |
| `n11/listing_ids_capture.js` | util | Browser console paste — manually capture listing IDs |
| `n11/manual.js` | util | Browser console paste — manual review capture with autofetch |

### npm Scripts

```bash
npm run scrape_product        # Phase 1: collect product IDs
npm run scrape_review_def     # Phase 2: concurrency 3 (default)
npm run scrape_review_4       # Phase 2: concurrency 4
npm run scrape_review_5       # Phase 2: concurrency 5
npm run scrape_arda           # Phase 2: arda's team slice
npm run scrape_tugce          # Phase 2: tugce's team slice
npm run scrape_havvagul       # Phase 2: havvagul's team slice
npm run failed_scrapes        # Retry failed jobs (concurrency 3)
npm run failed_scrapes_4      # Retry failed jobs (concurrency 4)
npm run previous_scrapes      # List incomplete runs
npm run all_scrapes           # List all runs including completed
npm run scrape_help           # Full CLI reference (English)
```

### CLI Flags (`n11/collection_auto_rawData.js`)

| Flag | Description |
|---|---|
| `--name=<runId>` | Name a run (used for log file naming) |
| `--resume-run=<runId>` | Resume an interrupted run by ID |
| `--categories=<slug1,slug2>` | Run only specific category slugs |
| `--products=<id1,id2>` | Run only specific product IDs |
| `--team=<arda\|tugce\|havvagul>` | Run your pre-assigned category slice |
| `--concurrency=<n>` | Override worker count (default 3, max recommended 5) |
| `--failed-only` | Retry jobs from `n11/logs/failed_jobs_latest.json` |
| `--failed-file=<path>` | Retry from a specific failed jobs file |
| `--list-runs` | List previous incomplete runs |
| `--list-all-runs` | List all runs including completed |

Flags can be combined: `--name=mobilya-test --categories=mobilya --concurrency=4`

### Team Assignments

**arda:** kitap, dekorasyon-ve-aydinlatma, telefon-ve-aksesuarlari, ses-sistemleri-ve-navigasyon, motosiklet, kadin-bakim-urunleri, su-sporlari, yuz-ve-vucut-bakimi, cinsel-urunler, supermarket, beslenme-ve-mama-sandalyesi, bilgisayar, video-oyun-konsol, bebek-giyim, bireysel-ve-takim-sporlari, emzirme-urunleri, guzellik-salonu-ve-kuafor-urunleri, kis-sporlari, televizyon-ve-ses-sistemleri

**tugce:** kadin-giyim-aksesuar, outdoor-ve-kamp, erkek-giyim-aksesuar, evcil-hayvan-urunleri, yedek-parca-otomobil, bisiklet-ve-scooter, elektrikli-ev-aletleri, lastik-ve-jant, mutfak-gerecleri, spor-giyim-ve-ayakkabi, avcilik-ve-balikcilik, erkek-bakim-urunleri, mobilya, bebek-bezi-ve-islak-mendil, biberon-ve-aksesuarlari, dugun-davet-organizasyon, fotograf-ve-kamera, ilginc-akilli-urunler, tekne-ve-yat-malzemeleri

**havvagul:** parfum-ve-deodorant, saglik-ve-medikal-urunler, ev-tekstili, kirtasiye-ve-ofis, beyaz-esya, yetiskin-hobi-ve-oyun, muzik, sac-bakim-ve-sekillendirme, bebek-odasi-ve-park-yatak, makyaj, cocuk-oyuncaklari-ve-parti, fitness-ve-kondisyon, yapi-market-ve-bahce, bebek-guvenlik, dijital-kodlar-urunler, film, hamile-giyim, oto-koltugu-ve-ana-kucagi, yurutec-ve-yurume-yardimcilari, yasam-ve-etkinlik

### Output Directories

| Path | Contents |
|---|---|
| `n11/product_ids/<slug>_ids.json` | Phase 1 output — product ID list per category |
| `n11/raw_data/<slug>/<productId>_reviews.json` | Phase 2 output — reviews for one product |
| `n11/raw_data/<slug>/<productId>_reviews.partial.json` | Checkpoint — interrupted scrape in progress |
| `n11/logs/<runId>.log` | Per-run verbose log |
| `n11/logs/<runId>_summary.json` | Per-run aggregate stats |
| `n11/logs/<runId>_failed_jobs.json` | Per-run failed product list |
| `n11/logs/current_status.json` | Live status file written during an active run |
| `n11/logs/failed_jobs_latest.json` | Most recent failed list (used by `--failed-only`) |

### Rate Limits & Timing Constants

| Constant | Value | Scope |
|---|---|---|
| `REVIEW_CONCURRENCY` | 3 | Default workers for Phase 2 |
| `REVIEW_DELAY_MS` | 350ms | Base delay between requests |
| `REVIEW_MAX_PAGES` | 500 | Max pages per product |
| `CHECKPOINT_EVERY_PAGES` | 5 | Save partial progress every N pages |
| `REVIEW_RETRY_ATTEMPTS` | 3 | Retries per product |
| `REVIEW_RETRY_DELAY_MS` | 1200ms | Backoff between retries |
| `MAX_CONSECUTIVE_WORKER_ERRORS` | 5 | Browser page recycled after N consecutive errors |

Do not modify these constants in source — use CLI flags (`--concurrency=<n>`) to override.

### Failure Recovery

1. Check `n11/logs/failed_jobs_latest.json` — inspect `failedCount` and error messages
2. Run `npm run failed_scrapes` to retry with concurrency 3
3. Or `npm run failed_scrapes_4` for higher throughput
4. Resume an interrupted run: `node n11/collection_auto_rawData.js --resume-run=<runId>`
5. Retry a single product: `node n11/collection_auto_rawData.js --products=<productId> --name=debug-<productId>`

---

## Trendyol Scraper (`trendyol/`)

### Key Scripts

| Script | Phase | What it does |
|---|---|---|
| `trendyol/collect_category_ids.js` | 1 | Scrapes product IDs+URLs from category pages → `trendyol/product_ids/` |

### Output Format (differs from n11)

Stores `{id, url}` objects instead of bare IDs — `url` is used directly for review URL construction:

```
review URL = https://www.trendyol.com + product.url + /yorumlar
```

### Categories

Edit `trendyol/categories.txt` to add category URLs before running.

---

## Code Conventions

- CommonJS (`require`/`module.exports`) — no TypeScript, no build step
- All paths use `path.join(__dirname, ...)` — never hardcoded strings
- `fs.existsSync` guards before any directory creation
- Playwright `chromium` only (no firefox/webkit)
- n11: HTTP requests go through `page.evaluate(fetch(...))` — no external HTTP libraries
- Trendyol: network interception via `page.on('response', ...)` to capture listing API
- Workers share state via `Map` objects and write `logs/current_status.json` for live monitoring
- Ctrl+C triggers graceful shutdown — in-progress work is checkpointed before exit

## Do Not Touch

- `n11/categories.txt` — shared category list, coordinate with team before editing
- `n11/categories_old.txt` — archived, do not delete
- `.npmrc` — npm configuration, do not modify without team discussion
