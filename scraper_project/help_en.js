#!/usr/bin/env node
// English command reference for the n11 Review Scraper.
// Run with: npm run scrape_help

const lines = `
╔══════════════════════════════════════════════════════════════╗
║          n11 Review Scraper — Command Reference (EN)         ║
╚══════════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 PHASE 1 — COLLECT PRODUCT IDs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run scrape_product
  Reads every URL in categories.txt, paginates through each category
  (starting at page 2), and saves up to 1,000 unique product IDs per
  category to product_ids/<slug>_ids.json.
    • 3 concurrent workers
    • 250 ms base delay + random jitter between page requests
    • Max 200 pages per category
    • Stops early if a duplicate page is detected (end-of-listing guard)
    • Ctrl+C triggers a graceful shutdown that saves partial results

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 PHASE 2 — COLLECT REVIEWS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run scrape_review_def
  Scrapes reviews for every product found in product_ids/.
  Saves completed data to raw_data/<category>/<productId>_reviews.json.
  Uses concurrency 3 (default — good balance of speed and server load).
    • 350 ms base delay + random jitter between page requests
    • Max 500 review pages per product
    • Saves a .partial.json checkpoint every 5 pages
    • 3 retry attempts with 1.2 s backoff on failure
    • Skips products that are already fully completed
    • Deduplicates reviews by ID before saving

npm run scrape_review_4
  Same as scrape_review_def but with 4 concurrent workers.
  Runs faster — good when you have spare bandwidth.

npm run scrape_review_5
  Same as scrape_review_def but with 5 concurrent workers.
  Fastest option — use when you need to finish quickly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 TEAM SHORTCUTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Each team member has a fixed set of pre-assigned categories.
Any category not pre-assigned is automatically balanced to the
team member with the lightest current load.

npm run scrape_arda
  Runs review scraping for Arda's assigned categories.
  Assigned: kitap, dekorasyon, telefon, ses-sistemleri, motosiklet,
  kadin-bakim, su-sporlari, yuz-ve-vucut-bakimi, cinsel-urunler,
  supermarket, beslenme, bilgisayar, video-oyun, bebek-giyim,
  bireysel-ve-takim-sporlari, emzirme, guzellik-salonu, kis-sporlari,
  televizyon-ve-ses-sistemleri

npm run scrape_tugce
  Runs review scraping for Tugce's assigned categories.
  Assigned: kadin-giyim-aksesuar, outdoor, erkek-giyim-aksesuar,
  evcil-hayvan, yedek-parca, bisiklet, elektrikli-ev-aletleri,
  lastik-ve-jant, mutfak, spor-giyim, avcilik, erkek-bakim, mobilya,
  bebek-bezi, biberon, dugun-davet, fotograf, ilginc-akilli, tekne

npm run scrape_havvagul
  Runs review scraping for Havvagul's assigned categories.
  Assigned: parfum-ve-deodorant, saglik-ve-medikal, ev-tekstili,
  kirtasiye, beyaz-esya, yetiskin-hobi, muzik, sac-bakim, bebek-odasi,
  makyaj, cocuk-oyuncaklari, fitness, yapi-market, bebek-guvenlik,
  dijital-kodlar, film, hamile-giyim, oto-koltugu, yurutec,
  yasam-ve-etkinlik

  Tip — limit to first N categories:
    node collection_auto_rawData.js --team=arda 5

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 RUN MANAGEMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run previous_scrapes
  Lists all incomplete (still-in-progress or interrupted) review runs.
  Use this to find a run ID you want to resume.

npm run all_scrapes
  Lists every run including fully completed ones, with stats.

npm run failed_scrapes
  Retries all jobs that failed during the most recent run.
  Reads from logs/failed_jobs_latest.json automatically.
  Uses default concurrency 3.

npm run failed_scrapes_4
  Same as failed_scrapes but with concurrency 4 — faster retry.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 HELP & EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run scrape_help        → This page (English)
npm run scrape_yardim      → Same page in Turkish
npm run resume_help        → Examples for resuming interrupted runs
npm run failed_help        → Examples for retrying failed jobs
npm run named_run_help     → Examples for starting named runs

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 DIRECT CLI FLAGS
 Usage: node collection_auto_rawData.js [flags]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

--name=<runName>
  Assigns a label to this run. The label is used for log file names
  and lets you resume or reference the run later.
  Example:
    node collection_auto_rawData.js --name=agiz-dis-bakimi

--resume-run=<runId>
  Resumes a previously started run by its name/ID. Already-completed
  products are skipped automatically so no work is duplicated.
  Example:
    node collection_auto_rawData.js --resume-run=agiz-dis-bakimi

--concurrency=<n>
  Overrides how many browser workers run in parallel (default: 3).
  Higher values finish faster but put more load on the target site.
  Example:
    node collection_auto_rawData.js --resume-run=my-run --concurrency=6

--categories=<slug1,slug2,...>
  Filters the run to only the listed category slugs (comma-separated,
  no spaces). Useful for targeting a specific subset.
  Example:
    node collection_auto_rawData.js --categories=mobilya,telefon-ve-aksesuarlari

--products=<id1,id2,...>
  Filters the run to only the listed product IDs (comma-separated).
  Useful for spot-checking or retrying specific products.
  Example:
    node collection_auto_rawData.js --products=734699208,734700038

--team=<name>
  Runs only the categories pre-assigned to that team member.
  Valid values: arda, tugce, havvagul.
  Unassigned categories are dynamically balanced to the lightest team.
  Example:
    node collection_auto_rawData.js --team=tugce
  Limit to first N categories:
    node collection_auto_rawData.js --team=havvagul 10

--failed-only
  Retries only the jobs listed in the current failed jobs file.
  By default reads logs/failed_jobs_latest.json.
  Can be combined with --failed-file to target a specific file.
  Example:
    node collection_auto_rawData.js --failed-only

--failed-file=<path>
  Specifies which failed jobs JSON file to use when retrying.
  Must be used together with --failed-only.
  Example:
    node collection_auto_rawData.js --failed-only --failed-file=logs/agiz-dis-bakimi_failed_jobs.json

--list-runs
  Prints a table of all incomplete (unfinished) runs and exits.
  Equivalent to: npm run previous_scrapes

--list-all-runs
  Prints a table of all runs (finished and unfinished) and exits.
  Equivalent to: npm run all_scrapes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 COMBINING FLAGS — EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Start a named run for two categories with 4 workers:
  node collection_auto_rawData.js --name=test-run --categories=mobilya,telefon-ve-aksesuarlari --concurrency=4

Resume that run with 6 workers:
  node collection_auto_rawData.js --resume-run=test-run --concurrency=6

Retry failed jobs from a specific log file with 4 workers:
  node collection_auto_rawData.js --failed-only --failed-file=logs/test-run_failed_jobs.json --concurrency=4

Name a failed-only retry run so it gets its own log:
  node collection_auto_rawData.js --failed-only --name=retry-run --concurrency=4

Run specific products within a category:
  node collection_auto_rawData.js --name=spot-check --categories=mobilya --products=734699208,734700038 --concurrency=2

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OUTPUT FILES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
product_ids/<slug>_ids.json
  Product IDs collected during Phase 1.

raw_data/<category>/<productId>_reviews.json
  Completed review data for a product.

raw_data/<category>/<productId>_reviews.partial.json
  In-progress checkpoint saved every 5 pages. Auto-removed when done.

logs/<runId>.log
  Full detailed log for the run (every page request, error, retry).

logs/<runId>_summary.json
  Completion statistics: jobs queued, completed, failed, reviews collected.

logs/<runId>_failed_jobs.json
  List of failed jobs with their error messages. Feed to --failed-file.

logs/failed_jobs_latest.json
  Symlink / copy of the most recent failed jobs file. Used by --failed-only.

logs/current_status.json
  Live worker status updated in real time during a run.
`.trim();

console.log(lines);
