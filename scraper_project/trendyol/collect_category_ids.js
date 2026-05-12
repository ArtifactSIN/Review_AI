"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const INPUT_FILE = path.join(__dirname, "categories.txt");
const OUTPUT_DIR = path.join(__dirname, "product_ids");

const TARGET_UNIQUE_IDS = 1000;
const START_PAGE = 1;
const DELAY_MS = 400;
const API_SETTLE_MS = 4000;   // wait after page load for XHR responses to arrive
const MAX_REPEAT_PAGES = 3;
const MAX_PAGES_PER_CATEGORY = 200;
const MAX_TASKS_PER_PAGE = 10;
const MAX_CONSECUTIVE_WORKER_ERRORS = 3;

const DEBUG = false;

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  let concurrency = 3;
  let status = false;
  let audit = false;
  let minProducts = 0;
  for (const arg of process.argv.slice(2)) {
    const mConc = arg.match(/^--concurrency=(\d+)$/);
    if (mConc) concurrency = parseInt(mConc[1], 10);
    const mMin = arg.match(/^--min-products=(\d+)$/);
    if (mMin) minProducts = parseInt(mMin[1], 10);
    if (arg === "--status") status = true;
    if (arg === "--audit") audit = true;
  }
  return { concurrency, status, audit, minProducts };
}

const { concurrency: CONCURRENCY, status: SHOW_STATUS, audit: SHOW_AUDIT, minProducts: MIN_PRODUCTS } = parseArgs();

// ─── state ────────────────────────────────────────────────────────────────────

let isShuttingDown = false;
// categoryUrl → { seen: Map<id, product>, lastPage: number }
const activeCategoryRuns = new Map();

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCategoryUrls() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Missing input file: ${INPUT_FILE}`);
  }
  const all = fs
    .readFileSync(INPUT_FILE, "utf8")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const seen = new Set();
  const unique = all.filter((u) => (seen.has(u) ? false : seen.add(u)));
  if (unique.length < all.length) {
    console.log(`[WARN] categories.txt: ${all.length - unique.length} duplicate URLs removed`);
  }
  return unique;
}

function slugFromCategoryUrl(categoryUrl) {
  const url = new URL(categoryUrl);
  const cleaned = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
  return cleaned || "category";
}

function buildPageUrl(categoryUrl, page) {
  const url = new URL(categoryUrl);
  url.searchParams.set("pi", String(page));
  return url.toString();
}

// ─── status command ───────────────────────────────────────────────────────────

function printStatus(categoryUrls) {
  let done = 0, partial = 0, pending = 0;
  console.log(`\n[STATUS] ${categoryUrls.length} categories in categories.txt\n`);
  for (const url of categoryUrls) {
    const slug = slugFromCategoryUrl(url);
    const donePath    = path.join(OUTPUT_DIR, `${slug}_ids.json`);
    const partialPath = path.join(OUTPUT_DIR, `${slug}_ids.partial.json`);
    if (fs.existsSync(donePath)) {
      const data = JSON.parse(fs.readFileSync(donePath, "utf8"));
      console.log(`  ✓ done     ${slug.padEnd(40)} ${data.uniqueCount} products`);
      done++;
    } else if (fs.existsSync(partialPath)) {
      const data = JSON.parse(fs.readFileSync(partialPath, "utf8"));
      console.log(`  ~ partial  ${slug.padEnd(40)} ${data.uniqueCount} products  (pg=${data.lastPage})`);
      partial++;
    } else {
      console.log(`  ✗ pending  ${slug}`);
      pending++;
    }
  }
  console.log(`\nSummary: ${done} done, ${partial} partial, ${pending} pending\n`);
}

// ─── audit command ────────────────────────────────────────────────────────────

function printAudit(categoryUrls) {
  const buckets = { 0: [], "1-9": [], "10-49": [], "50-99": [], "100-499": [], "500-999": [], "1000+": [] };
  const pending = [];
  const partial = [];

  for (const url of categoryUrls) {
    const slug = slugFromCategoryUrl(url);
    const donePath    = path.join(OUTPUT_DIR, `${slug}_ids.json`);
    const partialPath = path.join(OUTPUT_DIR, `${slug}_ids.partial.json`);

    if (fs.existsSync(donePath)) {
      const count = readDoneCount(slug) ?? 0;
      if      (count === 0)     buckets[0].push({ slug, count, url });
      else if (count < 10)      buckets["1-9"].push({ slug, count, url });
      else if (count < 50)      buckets["10-49"].push({ slug, count, url });
      else if (count < 100)     buckets["50-99"].push({ slug, count, url });
      else if (count < 500)     buckets["100-499"].push({ slug, count, url });
      else if (count < 1000)    buckets["500-999"].push({ slug, count, url });
      else                      buckets["1000+"].push({ slug, count, url });
    } else if (fs.existsSync(partialPath)) {
      try {
        const d = JSON.parse(fs.readFileSync(partialPath, "utf8"));
        partial.push({ slug, count: d.uniqueCount ?? 0, lastPage: d.lastPage, url });
      } catch { partial.push({ slug, count: 0, lastPage: "?", url }); }
    } else {
      pending.push({ slug, url });
    }
  }

  console.log(`\n[AUDIT] ${categoryUrls.length} total categories\n`);

  console.log("── Product count distribution ───────────────────────────────────────");
  console.log(`  ${"0 products".padEnd(14)} ${buckets[0].length.toString().padStart(4)}  ← SUSPECT (scrape failed or truly empty)`);
  console.log(`  ${"1-9".padEnd(14)} ${buckets["1-9"].length.toString().padStart(4)}  ← LOW (likely cut short)`);
  console.log(`  ${"10-49".padEnd(14)} ${buckets["10-49"].length.toString().padStart(4)}`);
  console.log(`  ${"50-99".padEnd(14)} ${buckets["50-99"].length.toString().padStart(4)}`);
  console.log(`  ${"100-499".padEnd(14)} ${buckets["100-499"].length.toString().padStart(4)}`);
  console.log(`  ${"500-999".padEnd(14)} ${buckets["500-999"].length.toString().padStart(4)}`);
  console.log(`  ${"1000+ (capped)".padEnd(14)} ${buckets["1000+"].length.toString().padStart(4)}  ← hit TARGET_UNIQUE_IDS cap`);
  console.log(`  ${"partial files".padEnd(14)} ${partial.length.toString().padStart(4)}`);
  console.log(`  ${"pending (no file)".padEnd(14)} ${pending.length.toString().padStart(4)}`);
  console.log("");

  if (buckets[0].length > 0) {
    console.log(`── 0-product categories (${buckets[0].length}) ─────────────────────────────────`);
    for (const { slug } of buckets[0]) console.log(`  ✗ ${slug}`);
    console.log("");
  }

  if (buckets["1-9"].length > 0) {
    console.log(`── 1-9 product categories (${buckets["1-9"].length}) ──────────────────────────────`);
    for (const { slug, count } of buckets["1-9"]) console.log(`  ! ${count.toString().padStart(3)} ${slug}`);
    console.log("");
  }

  if (partial.length > 0) {
    console.log(`── Partial files (${partial.length}) ────────────────────────────────────────`);
    for (const { slug, count, lastPage } of partial)
      console.log(`  ~ pg=${String(lastPage).padEnd(4)} ${count.toString().padStart(4)} products  ${slug}`);
    console.log("");
  }

  if (pending.length > 0) {
    console.log(`── Pending — no file (${pending.length}) ─────────────────────────────────────`);
    for (const { slug } of pending) console.log(`  ✗ ${slug}`);
    console.log("");
  }

  const suspect = buckets[0].length + buckets["1-9"].length + partial.length + pending.length;
  console.log(`── Re-run recommendation ────────────────────────────────────────────`);
  console.log(`  ${suspect} categories need attention.`);
  if (suspect > 0) {
    console.log(`  To re-run 0/low-count as if new:  node trendyol/collect_category_ids.js --min-products=10`);
    console.log(`  To re-run everything below 50:    node trendyol/collect_category_ids.js --min-products=50`);
  }
  console.log("");
}

// ─── resume helpers ───────────────────────────────────────────────────────────

function readDoneCount(slug) {
  const p = path.join(OUTPUT_DIR, `${slug}_ids.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    return d.uniqueCount ?? (Array.isArray(d.products) ? d.products.length : 0);
  } catch { return 0; }
}

function isCategoryComplete(slug) {
  const count = readDoneCount(slug);
  if (count === null) return false;
  if (MIN_PRODUCTS > 0 && count < MIN_PRODUCTS) return false;
  return true;
}

// Returns { products: [{id,url}], lastPage: N } or null.
// When --min-products is set and a done file exists but is below threshold,
// load its products as a base and restart from page 1 (lastPage: 0).
function loadPartialData(slug) {
  const partialPath = path.join(OUTPUT_DIR, `${slug}_ids.partial.json`);
  if (fs.existsSync(partialPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(partialPath, "utf8"));
      if (data.partial && typeof data.lastPage === "number" && Array.isArray(data.products)) {
        return { products: data.products, lastPage: data.lastPage };
      }
    } catch {}
  }
  // Under --min-products: done file exists but below threshold — re-run from pg 1, seed with existing
  if (MIN_PRODUCTS > 0) {
    const donePath = path.join(OUTPUT_DIR, `${slug}_ids.json`);
    if (fs.existsSync(donePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(donePath, "utf8"));
        const count = data.uniqueCount ?? 0;
        if (count < MIN_PRODUCTS && Array.isArray(data.products)) {
          console.log(`[RECHECK] ${slug} has ${count} products < ${MIN_PRODUCTS}, re-scraping from pg=1`);
          return { products: data.products, lastPage: 0 };
        }
      } catch {}
    }
  }
  return null;
}

function deletePartialFile(slug) {
  const partialPath = path.join(OUTPUT_DIR, `${slug}_ids.partial.json`);
  if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
}

// ─── product extraction ───────────────────────────────────────────────────────

// api/search/products → { products: [{id, url, name, ...}] }
function extractFromSearchProducts(json) {
  if (!Array.isArray(json?.products)) return [];
  const results = [];
  for (const item of json.products) {
    const id = String(item.id ?? item.contentId ?? item.productId ?? "").trim();
    const url = typeof item.url === "string" ? item.url : null;
    if (id && url) results.push({ id, url });
  }
  return results;
}

// api/search/color-variants → { groupId: [{id, url, name, ...}] }
function extractFromColorVariants(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const results = [];
  for (const variants of Object.values(json)) {
    if (!Array.isArray(variants)) continue;
    for (const item of variants) {
      const id = String(item.id ?? item.contentId ?? "").trim();
      const url = typeof item.url === "string" ? item.url : null;
      if (id && url) results.push({ id, url });
    }
  }
  return results;
}

// ─── per-page scrape via network interception ─────────────────────────────────

async function scrapePageWithInterception(page, pageUrl, slug, pg) {
  const collected = new Map(); // id → {id, url}

  const handler = async (response) => {
    const url = response.url();
    if (!url.includes("apigw.trendyol.com")) return;

    const isProducts      = url.includes("/api/search/products");
    const isColorVariants = url.includes("/api/search/color-variants");
    if (!isProducts && !isColorVariants) return;

    let bodyText;
    try {
      const buf = await response.body();
      bodyText = buf.toString("utf-8");
    } catch {
      return;
    }

    if (DEBUG) {
      console.log(`[DEBUG] ${url.slice(0, 120)}`);
      console.log(`[DEBUG] body[0:300] ${bodyText.slice(0, 300)}`);
    }

    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return;
    }

    let products;
    if (isProducts) {
      products = extractFromSearchProducts(json);
      if (DEBUG) console.log(`[DEBUG search/products] extracted ${products.length}`);
    } else {
      products = extractFromColorVariants(json);
      if (DEBUG) console.log(`[DEBUG color-variants] extracted ${products.length}`);
    }

    for (const p of products) {
      // Prefer entries that already have a url — don't overwrite with url-less ones
      if (!collected.has(p.id) || !collected.get(p.id).url) {
        collected.set(p.id, p);
      }
    }
  };

  page.on("response", handler);

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch {
    console.log(`[${slug}] pg=${pg} nav timeout, using collected so far`);
  }

  // Wait for in-flight XHRs (color-variants fire after the main products response)
  await sleep(API_SETTLE_MS);

  page.off("response", handler);

  if (DEBUG) console.log(`[DEBUG] pg=${pg} total after settle: ${collected.size}`);
  return Array.from(collected.values());
}

// ─── category loop ────────────────────────────────────────────────────────────

async function collectProductsForCategory(page, categoryUrl, resumeData) {
  const slug = slugFromCategoryUrl(categoryUrl);
  const seen = new Map();
  let startPage = START_PAGE;

  if (resumeData) {
    for (const p of resumeData.products) {
      if (p.id) seen.set(p.id, p);
    }
    startPage = resumeData.lastPage + 1;
  }

  // runInfo shared by reference — saveAllActivePartials reads lastPage live
  const runInfo = { seen, lastPage: startPage - 1 };
  activeCategoryRuns.set(categoryUrl, runInfo);

  if (resumeData) {
    console.log(`\n[RESUME] ${slug} from pg=${startPage} with ${seen.size} products loaded`);
  } else {
    console.log(`\n[START] ${slug}`);
  }

  let repeatCount = 0;
  let previousSignature = null;

  for (let pg = startPage; pg <= MAX_PAGES_PER_CATEGORY; pg++) {
    if (isShuttingDown) {
      console.log(`[${slug}] interrupt, stopping.`);
      break;
    }

    const pageUrl = buildPageUrl(categoryUrl, pg);
    let products = [];

    try {
      products = await scrapePageWithInterception(page, pageUrl, slug, pg);
    } catch (err) {
      console.error(`[${slug}] error at pg=${pg}: ${err.message}`);
      break;
    }

    if (products.length === 0) {
      console.log(`[${slug}] no products at pg=${pg}, stopping.`);
      break;
    }

    const signature = products.map((p) => p.id).join(",");
    if (signature === previousSignature) {
      repeatCount += 1;
      console.log(`[${slug}] repeated content pg=${pg} (${repeatCount}/${MAX_REPEAT_PAGES})`);
      if (repeatCount >= MAX_REPEAT_PAGES) {
        console.log(`[${slug}] repeat threshold reached, stopping.`);
        break;
      }
    } else {
      repeatCount = 0;
    }
    previousSignature = signature;

    let addedThisPage = 0;
    for (const product of products) {
      if (!seen.has(product.id)) {
        seen.set(product.id, product);
        addedThisPage += 1;
      }
    }

    // Update lastPage only after products are safely in seen — partial saves use this
    runInfo.lastPage = pg;

    console.log(`[${slug}] pg=${pg} +${addedThisPage} new, total=${seen.size}`);

    if (seen.size >= TARGET_UNIQUE_IDS) {
      console.log(`[${slug}] reached target ${TARGET_UNIQUE_IDS}, stopping.`);
      break;
    }

    await sleep(DELAY_MS + Math.floor(Math.random() * 150));
  }

  activeCategoryRuns.delete(categoryUrl);

  return {
    categoryUrl,
    slug,
    collectedAt: new Date().toISOString(),
    uniqueCount: seen.size,
    products: Array.from(seen.values()),
  };
}

// ─── save helpers ─────────────────────────────────────────────────────────────

function saveCategoryResult(result) {
  const fileName = `${result.slug}_ids.json`;
  const outputPath = path.join(OUTPUT_DIR, fileName);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`[SAVED] ${outputPath} (${result.uniqueCount} products)`);
}

function savePartialResult(categoryUrl, seen, lastPage) {
  const slug = slugFromCategoryUrl(categoryUrl);
  const result = {
    categoryUrl,
    slug,
    collectedAt: new Date().toISOString(),
    uniqueCount: seen.size,
    products: Array.from(seen.values()),
    lastPage,
    partial: true,
  };
  const outputPath = path.join(OUTPUT_DIR, `${slug}_ids.partial.json`);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`[PARTIAL SAVED] ${outputPath} (pg=${lastPage}, ${seen.size} products)`);
}

function saveAllActivePartials() {
  for (const [categoryUrl, { seen, lastPage }] of activeCategoryRuns.entries()) {
    try {
      savePartialResult(categoryUrl, seen, lastPage);
    } catch (err) {
      console.error(`[PARTIAL SAVE ERROR] ${categoryUrl}`);
      console.error(err);
    }
  }
}

// ─── worker pool ──────────────────────────────────────────────────────────────

async function createWorkerPage(context) {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(30000);
  // Block heavy resources — we only need API intercepts, not rendered content
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "stylesheet", "font", "media", "other"].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });
  return page;
}

async function recycleWorkerPage(context, workerId, page, reason) {
  try {
    if (page && !page.isClosed()) await page.close().catch(() => {});
  } finally {
    const nextPage = await createWorkerPage(context);
    console.log(`[WORKER ${workerId}] recycled (${reason}).`);
    return nextPage;
  }
}

// initialPage: reuse an existing tab so no extra blank tab is left open
async function worker(context, workerId, queue, initialPage) {
  let page = initialPage || await createWorkerPage(context);
  let tasksOnCurrentPage = 0;
  let consecutiveErrors = 0;

  try {
    while (queue.length > 0) {
      if (isShuttingDown) {
        console.log(`[WORKER ${workerId}] shutdown, exiting.`);
        return;
      }

      const categoryUrl = queue.shift();
      if (!categoryUrl) return;

      const slug = slugFromCategoryUrl(categoryUrl);

      if (isCategoryComplete(slug)) {
        console.log(`[SKIP] ${slug} already complete`);
        continue;
      }

      const resumeData = loadPartialData(slug);
      console.log(`\n[WORKER ${workerId}] starting ${categoryUrl}`);

      try {
        const result = await collectProductsForCategory(page, categoryUrl, resumeData);
        saveCategoryResult(result);
        deletePartialFile(slug);
        tasksOnCurrentPage += 1;
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        console.error(`[ERROR] ${categoryUrl}`);
        console.error(err);

        if (consecutiveErrors >= MAX_CONSECUTIVE_WORKER_ERRORS) {
          page = await recycleWorkerPage(context, workerId, page, `errors=${consecutiveErrors}`);
          consecutiveErrors = 0;
          tasksOnCurrentPage = 0;
        }
      }

      if (tasksOnCurrentPage >= MAX_TASKS_PER_PAGE) {
        page = await recycleWorkerPage(context, workerId, page, `task limit=${tasksOnCurrentPage}`);
        tasksOnCurrentPage = 0;
      }
    }
  } finally {
    if (page && !page.isClosed()) await page.close().catch(() => {});
  }
}

async function runWithConcurrency(context, categoryUrls, concurrency) {
  const queue = [...categoryUrls];
  // Reuse existing tabs (e.g. the default blank from launchPersistentContext)
  // so no idle blank tab sits in the background.
  const existing = context.pages();
  console.log(`[TRENDYOL] ${categoryUrls.length} categories, concurrency=${concurrency}`);
  const workers = Array.from({ length: concurrency }, (_, i) =>
    worker(context, i + 1, queue, existing[i] ?? null)
  );
  await Promise.all(workers);
}

// ─── signal handling ──────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("\n[INTERRUPT] Ctrl+C received. Saving partial results...");
  saveAllActivePartials();
});

// ─── entry point ──────────────────────────────────────────────────────────────

(async () => {
  const categoryUrls = readCategoryUrls();

  if (SHOW_STATUS) {
    printStatus(categoryUrls);
    process.exit(0);
  }

  if (SHOW_AUDIT) {
    printAudit(categoryUrls);
    process.exit(0);
  }

  if (MIN_PRODUCTS > 0) {
    console.log(`[INFO] --min-products=${MIN_PRODUCTS}: categories with fewer products will be re-scraped`);
  }

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, ".pw-user"),
    {
      headless: false,
      args: [
        // Anti-detection: hide navigator.webdriver and automation fingerprint
        "--disable-blink-features=AutomationControlled",
        // WSL/container stability
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        // GPU: disable hardware, keep software rasterizer for non-headless rendering
        "--disable-gpu",
        // Suppress noise
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--disable-notifications",
        "--mute-audio",
        // Memory: 512MB V8 heap — 256 was too tight and caused crashes on complex pages
        "--js-flags=--max-old-space-size=512",
      ],
      viewport: { width: 1280, height: 900 },
    }
  );

  try {
    await runWithConcurrency(context, categoryUrls, CONCURRENCY);
  } catch (err) {
    console.error("[FATAL] scraping failed");
    console.error(err);
  } finally {
    await context.close();
  }

  console.log("\nAll categories finished.");
})();
