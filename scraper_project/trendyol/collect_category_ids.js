"use strict";

const fs = require("fs");
const path = require("path");
// playwright loaded lazily so --partition-only works without a browser
let chromium;

const INPUT_FILE = path.join(__dirname, "categories.txt");
const OUTPUT_DIR = path.join(__dirname, "product_ids");

const TARGET_UNIQUE_IDS = 0; // 0 = unlimited; use --target=<n> to set a cap
const DELAY_MS = 400;
const MAX_TASKS_PER_PAGE = 10;
const MAX_CONSECUTIVE_WORKER_ERRORS = 3;

const API_BASE = "https://apigw.trendyol.com/discovery-sfint-search-service/api/search/products";

const DEBUG = false;

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  let concurrency = 3;
  let status = false;
  let audit = false;
  let minProducts = 0;
  let target = 0;
  let fixNames = false;
  let partitionOnly = false;
  for (const arg of process.argv.slice(2)) {
    const mConc = arg.match(/^--concurrency=(\d+)$/);
    if (mConc) concurrency = parseInt(mConc[1], 10);
    const mMin = arg.match(/^--min-products=(\d+)$/);
    if (mMin) minProducts = parseInt(mMin[1], 10);
    const mTarget = arg.match(/^--target=(\d+)$/);
    if (mTarget) target = parseInt(mTarget[1], 10);
    if (arg === "--status") status = true;
    if (arg === "--audit") audit = true;
    if (arg === "--fix-names") fixNames = true;
    if (arg === "--partition-only") partitionOnly = true;
  }
  return { concurrency, status, audit, minProducts, target, fixNames, partitionOnly };
}

const { concurrency: CONCURRENCY, status: SHOW_STATUS, audit: SHOW_AUDIT, minProducts: MIN_PRODUCTS, target: _TARGET_ARG, fixNames: FIX_NAMES, partitionOnly: PARTITION_ONLY } = parseArgs();
const EFFECTIVE_TARGET = _TARGET_ARG > 0 ? _TARGET_ARG : TARGET_UNIQUE_IDS; // 0 = no cap

// ─── state ────────────────────────────────────────────────────────────────────

let isShuttingDown = false;
let newIdsSaved = 0; // incremented each time saveCategoryResult writes a file
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

function allNamesPresent(slug) {
  const p = path.join(OUTPUT_DIR, `${slug}_ids.json`);
  if (!fs.existsSync(p)) return true;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const prods = Array.isArray(data.products) ? data.products : [];
    return prods.every(prod => typeof prod.name === "string" && prod.name.length > 0);
  } catch { return false; }
}

// Returns { products, lastPage, nextUrl } or null.
// nextUrl: saved _links.next URL so resume continues exactly where it stopped.
// When --min-products triggers a recheck, nextUrl is null → restarts from pi=1.
function loadPartialData(slug) {
  const partialPath = path.join(OUTPUT_DIR, `${slug}_ids.partial.json`);
  if (fs.existsSync(partialPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(partialPath, "utf8"));
      if (data.partial && typeof data.lastPage === "number" && Array.isArray(data.products)) {
        return { products: data.products, lastPage: data.lastPage, nextUrl: data.nextUrl || null };
      }
    } catch {}
  }
  // Under --min-products: done file exists but below threshold — re-run from pi=1, seed with existing
  if (MIN_PRODUCTS > 0) {
    const donePath = path.join(OUTPUT_DIR, `${slug}_ids.json`);
    if (fs.existsSync(donePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(donePath, "utf8"));
        const count = data.uniqueCount ?? 0;
        if (count < MIN_PRODUCTS && Array.isArray(data.products)) {
          console.log(`[RECHECK] ${slug} has ${count} products < ${MIN_PRODUCTS}, re-scraping from pi=1`);
          return { products: data.products, lastPage: 0, nextUrl: null };
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

// ─── API helpers ──────────────────────────────────────────────────────────────

function pathModelFromCategoryUrl(categoryUrl) {
  const parts = new URL(categoryUrl).pathname.replace(/^\/+|\/+$/g, "").split("/");
  return parts[parts.length - 1] || "";
}

function buildFirstPageUrlFromPathModel(pathModel) {
  return `${API_BASE}?pi=1&pathModel=${encodeURIComponent(pathModel)}&channelId=1&storefrontId=1&culture=tr-TR`;
}

function buildFirstPageUrl(categoryUrl) {
  return buildFirstPageUrlFromPathModel(pathModelFromCategoryUrl(categoryUrl));
}

async function detectCanonicalPathModel(page, categoryUrl) {
  const fromUrl = pathModelFromCategoryUrl(categoryUrl);
  try {
    const finalUrl = page.url();
    if (finalUrl && !finalUrl.startsWith("about:") && finalUrl !== categoryUrl) {
      const detected = pathModelFromCategoryUrl(finalUrl);
      if (detected && detected !== fromUrl) return detected;
    }
  } catch {}
  return fromUrl;
}

// Direct API fetch — same pattern as n11's fetchListingPage
async function fetchProductsPage(page, apiUrl) {
  return await page.evaluate(async (url) => {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "x-requested-with": "XMLHttpRequest",
      },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json };
  }, apiUrl);
}

function extractProducts(json) {
  if (!Array.isArray(json?.products)) return [];
  const results = [];
  for (const item of json.products) {
    const id   = String(item.id ?? item.contentId ?? item.productId ?? "").trim();
    const url  = typeof item.url === "string" ? item.url : null;
    const name = typeof item.name === "string" ? item.name.trim() || null : null;
    if (id && url) results.push({ id, url, name });
  }
  return results;
}

// ─── category scrape via direct API fetch + _links.next chain ─────────────────

async function collectProductsForCategory(page, categoryUrl, resumeData) {
  const slug = slugFromCategoryUrl(categoryUrl);
  const seen = new Map();

  if (resumeData) {
    for (const p of resumeData.products) {
      if (p.id) seen.set(p.id, p);
    }
  }

  // runInfo shared by reference — saveAllActivePartials reads live
  const runInfo = { seen, lastPage: 0, nextUrl: null };
  activeCategoryRuns.set(categoryUrl, runInfo);

  // Navigate once to seed cookies and detect real pathModel.
  // For y-s URLs (e.g. sarjli-dis-fircasi-y-s6592), page.url() doesn't change after navigation
  // but the page's JS makes an API call with a different resolved pathModel.
  // Intercept that response to capture the correct first-page URL.
  let canonicalPathModel = pathModelFromCategoryUrl(categoryUrl);
  let interceptedFirstUrl = null;

  const onApiResponse = (response) => {
    if (interceptedFirstUrl) return;
    const u = response.url();
    if (u.includes("discovery-sfint-search-service") && u.includes("pi=1")) {
      interceptedFirstUrl = u;
    }
  };

  if (!resumeData?.nextUrl) page.on("response", onApiResponse);

  try {
    await page.goto(categoryUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait up to 2s for the page's first search API call to fire
    if (!resumeData?.nextUrl) {
      for (let i = 0; i < 10 && !interceptedFirstUrl; i++) await sleep(200);
    }

    if (interceptedFirstUrl) {
      const pm = new URL(interceptedFirstUrl).searchParams.get("pathModel");
      if (pm && pm !== pathModelFromCategoryUrl(categoryUrl)) {
        console.log(`[${slug}] pathModel intercepted → ${pm}`);
        canonicalPathModel = pm;
      }
    } else {
      // Fallback: check if the URL itself redirected
      canonicalPathModel = await detectCanonicalPathModel(page, categoryUrl);
      if (canonicalPathModel !== pathModelFromCategoryUrl(categoryUrl)) {
        console.log(`[${slug}] pathModel remapped → ${canonicalPathModel}`);
      }
    }
  } catch {
    console.log(`[${slug}] nav timeout, continuing with fetch`);
  } finally {
    if (!resumeData?.nextUrl) page.off("response", onApiResponse);
  }

  if (resumeData) {
    console.log(`\n[RESUME] ${slug} from pi=${resumeData.lastPage + 1} with ${seen.size} pre-loaded`);
  } else {
    console.log(`\n[START] ${slug}`);
  }

  // Resuming: use saved nextUrl. Fresh start: prefer intercepted URL (captures real pathModel for y-s),
  // fall back to constructed URL from canonical pathModel.
  let nextUrl = resumeData?.nextUrl || interceptedFirstUrl || buildFirstPageUrlFromPathModel(canonicalPathModel);
  let pageNum = resumeData?.lastPage || 0;

  while (nextUrl && !isShuttingDown && (EFFECTIVE_TARGET === 0 || seen.size < EFFECTIVE_TARGET)) {
    pageNum++;

    let payload;
    try {
      payload = await fetchProductsPage(page, nextUrl);
    } catch (err) {
      console.error(`[${slug}] fetch error at pi=${pageNum}: ${err.message}`);
      break;
    }

    if (!payload.ok || !payload.json) {
      console.log(`[${slug}] HTTP ${payload.status} at pi=${pageNum}, stopping.`);
      break;
    }

    const products = extractProducts(payload.json);
    if (products.length === 0) {
      console.log(`[${slug}] no products at pi=${pageNum}, stopping.`);
      break;
    }

    let addedThisPage = 0;
    for (const p of products) {
      if (!seen.has(p.id)) {
        seen.set(p.id, p);
        addedThisPage++;
      }
    }

    // Advance cursor — _links.next is the complete URL for the next page
    nextUrl = payload.json._links?.next ?? null;

    runInfo.lastPage = pageNum;
    runInfo.nextUrl  = nextUrl; // saved in partial so resume can continue from here
    console.log(`[${slug}] pi=${pageNum} +${addedThisPage} new, total=${seen.size}`);

    if (EFFECTIVE_TARGET > 0 && seen.size >= EFFECTIVE_TARGET) {
      console.log(`[${slug}] reached target ${EFFECTIVE_TARGET}.`);
      break;
    }

    await sleep(DELAY_MS + Math.floor(Math.random() * 150));
  }

  if (isShuttingDown) console.log(`[${slug}] interrupt, stopping.`);
  else if (!nextUrl) console.log(`[${slug}] catalog exhausted (${seen.size} products).`);

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
  newIdsSaved++;
  console.log(`[SAVED] ${outputPath} (${result.uniqueCount} products)`);
}

function savePartialResult(categoryUrl, seen, lastPage, nextUrl) {
  const slug = slugFromCategoryUrl(categoryUrl);
  const result = {
    categoryUrl,
    slug,
    collectedAt: new Date().toISOString(),
    uniqueCount: seen.size,
    products: Array.from(seen.values()),
    lastPage,
    nextUrl: nextUrl || null,
    partial: true,
  };
  const outputPath = path.join(OUTPUT_DIR, `${slug}_ids.partial.json`);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`[PARTIAL SAVED] ${outputPath} (pi=${lastPage}, ${seen.size} products)`);
}

function saveAllActivePartials() {
  for (const [categoryUrl, { seen, lastPage, nextUrl }] of activeCategoryRuns.entries()) {
    try {
      savePartialResult(categoryUrl, seen, lastPage, nextUrl);
    } catch (err) {
      console.error(`[PARTIAL SAVE ERROR] ${categoryUrl}`);
      console.error(err);
    }
  }
}

// ─── team partition ───────────────────────────────────────────────────────────

function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function regenerateAssignments() {
  const teams = ["arda", "tugce", "havvagul"];
  if (!fs.existsSync(OUTPUT_DIR)) {
    console.log("[PARTITION] No product_ids/ dir, skipping.");
    return;
  }
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith("_ids.json") && !f.includes(".partial."));
  const cats = files.flatMap(f => {
    const d = safeReadJson(path.join(OUTPUT_DIR, f));
    if (!d) return [];
    const slug  = d.slug || f.replace(/_ids\.json$/, "");
    const count = d.uniqueCount || (Array.isArray(d.products) ? d.products.length : 0);
    return count > 0 ? [{ slug, count }] : [];
  });
  cats.sort((a, b) => b.count - a.count); // heaviest first → better balance

  const loads  = Object.fromEntries(teams.map(t => [t, 0]));
  const result = Object.fromEntries(teams.map(t => [t, []]));
  for (const cat of cats) {
    const lightest = [...teams].sort((a, b) => loads[a] - loads[b])[0];
    result[lightest].push(cat.slug);
    loads[lightest] += cat.count;
  }

  const logsDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const outPath = path.join(logsDir, "team_assignments.json");
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2), "utf8");
  console.log(`[PARTITION] Written → ${outPath}`);
  console.log(`[PARTITION] arda=${result.arda.length} tugce=${result.tugce.length} havvagul=${result.havvagul.length} categories`);
  console.log(`[PARTITION] product-load: arda=${loads.arda} tugce=${loads.tugce} havvagul=${loads.havvagul}`);
}

// ─── fix-names mode ───────────────────────────────────────────────────────────

async function fixNamesForCategory(page, categoryUrl) {
  const slug = slugFromCategoryUrl(categoryUrl);
  const idsPath = path.join(OUTPUT_DIR, `${slug}_ids.json`);

  if (!fs.existsSync(idsPath)) {
    console.log(`[SKIP] ${slug} already complete`);
    return;
  }

  const data = JSON.parse(fs.readFileSync(idsPath, "utf8"));
  const products = Array.isArray(data.products) ? data.products : [];
  const missingCount = products.filter(p => !p.name).length;

  if (missingCount === 0) {
    console.log(`[SKIP] ${slug} already complete`);
    return;
  }

  console.log(`\n[START] ${slug}`);
  console.log(`[FIX-NAMES] ${slug} — ${missingCount}/${products.length} missing names`);

  let canonicalPathModel = pathModelFromCategoryUrl(categoryUrl);
  try {
    await page.goto(categoryUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    canonicalPathModel = await detectCanonicalPathModel(page, categoryUrl);
    if (canonicalPathModel !== pathModelFromCategoryUrl(categoryUrl)) {
      console.log(`[${slug}] pathModel remapped → ${canonicalPathModel}`);
    }
  } catch { console.log(`[${slug}] nav timeout, continuing`); }

  const nameMap = new Map();
  let nextUrl = buildFirstPageUrlFromPathModel(canonicalPathModel);
  let pageNum = 0;

  while (nextUrl && !isShuttingDown) {
    pageNum++;
    let payload;
    try { payload = await fetchProductsPage(page, nextUrl); }
    catch (err) { console.error(`[${slug}] fetch error pi=${pageNum}: ${err.message}`); break; }

    if (!payload.ok || !payload.json) {
      console.log(`[${slug}] HTTP ${payload.status} at pi=${pageNum}, stopping.`);
      break;
    }

    const pageProducts = extractProducts(payload.json);
    if (pageProducts.length === 0) {
      console.log(`[${slug}] no products at pi=${pageNum}, stopping.`);
      break;
    }

    for (const p of pageProducts) {
      if (p.name && !nameMap.has(p.id)) nameMap.set(p.id, p.name);
    }

    nextUrl = payload.json._links?.next ?? null;
    console.log(`[${slug}] pi=${pageNum} +0 new, total=${nameMap.size}`);
    await sleep(DELAY_MS + Math.floor(Math.random() * 150));
  }

  let filled = 0;
  const updated = products.map(p => {
    if (!p.name && nameMap.has(p.id)) { filled++; return { ...p, name: nameMap.get(p.id) }; }
    return p;
  });

  data.products = updated;
  data.collectedAt = new Date().toISOString();
  fs.writeFileSync(idsPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`[SAVED] ${idsPath} (${updated.length} products)`);
  console.log(`[FIX-NAMES] ${slug} filled ${filled}/${missingCount} names`);
}

// ─── worker pool ──────────────────────────────────────────────────────────────

async function createWorkerPage(context) {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(30000);
  // Block everything except documents, scripts, and XHR/fetch.
  // No rendering or layout needed — page is navigated only to seed session cookies.
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

      if (FIX_NAMES) {
        if (allNamesPresent(slug)) {
          console.log(`[SKIP] ${slug} already complete`);
          continue;
        }
      } else {
        if (isCategoryComplete(slug)) {
          console.log(`[SKIP] ${slug} already complete`);
          continue;
        }
      }

      console.log(`\n[WORKER ${workerId}] starting ${categoryUrl}`);

      try {
        if (FIX_NAMES) {
          await fixNamesForCategory(page, categoryUrl);
        } else {
          const resumeData = loadPartialData(slug);
          const result = await collectProductsForCategory(page, categoryUrl, resumeData);
          saveCategoryResult(result);
          deletePartialFile(slug);
        }
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
  if (PARTITION_ONLY) {
    regenerateAssignments();
    process.exit(0);
  }

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
  if (EFFECTIVE_TARGET !== TARGET_UNIQUE_IDS) {
    console.log(`[INFO] --target=${EFFECTIVE_TARGET}: collecting up to ${EFFECTIVE_TARGET} products per category`);
  }

  ({ chromium } = require("playwright"));
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
  if (newIdsSaved > 0) {
    console.log(`\n[PARTITION] ${newIdsSaved} categor${newIdsSaved === 1 ? "y" : "ies"} updated — regenerating team assignments...`);
    regenerateAssignments();
  }
})();
