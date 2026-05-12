"use strict";
const fs   = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ── Constants ─────────────────────────────────────────────────────────────────

const REVIEW_API_BASE   = "https://apigw.trendyol.com/discovery-storefront-trproductgw-service/api/review-read/product-reviews/detailed";
const PAGE_SIZE         = 20;
const REVIEW_CONCURRENCY     = 3;
const REVIEW_DELAY_MS        = 400;
const REVIEW_MAX_PAGES       = 500;
const CHECKPOINT_EVERY       = 5;
const RETRY_ATTEMPTS         = 3;
const RETRY_DELAY_MS         = 1200;
const MAX_CONSECUTIVE_ERRORS = 5;

const TEAMS = ["arda", "tugce", "havvagul"];

// Fields consumed by the schema transform — everything else is "excluded"
const SCHEMA_SOURCE_KEYS = new Set([
  "contentId", "id",
  "rate", "score", "starCount",
  "comment", "text", "reviewText",
  "createdAt", "lastModifiedAt",
  "sellerName", "merchantName",
  "userFullName", "maskedBuyerName",
  "likesCount", "helpfulVoteCount",
  "images", "imageCount",
  "isElite", "isInfluencer", "trusted", "isVerified",
]);

// ── Paths ─────────────────────────────────────────────────────────────────────

const PRODUCT_IDS_DIR   = path.join(__dirname, "product_ids");
const RAW_DATA_DIR      = path.join(__dirname, "raw_data");
const EXCLUDED_DATA_DIR = path.join(__dirname, "excluded_data");
const LOGS_DIR          = path.join(__dirname, "logs");
const SHARED_META_PATH  = path.join(LOGS_DIR, "shared_meta.json");
const GID_COUNTER_PATH  = path.join(__dirname, "..", "logs", "gid_counter.json");
const USER_DATA_DIR     = path.join(__dirname, ".pw-user-reviews");

// ── Bootstrap directories ─────────────────────────────────────────────────────

for (const dir of [RAW_DATA_DIR, EXCLUDED_DATA_DIR, LOGS_DIR, USER_DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Globals mutated by workers ────────────────────────────────────────────────

let isShuttingDown  = false;
let shutdownTimerId = null;
let sharedMeta      = null;
let userState       = null;
let currentTeam     = null;

const activeReviewRuns = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sanitize(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "output";
}

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function ts()         { return new Date().toISOString(); }

function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

function safeWriteJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

// ── Console logging ───────────────────────────────────────────────────────────

const _log   = console.log.bind(console);
const _error = console.error.bind(console);
const _warn  = console.warn.bind(console);

function appendLog(level, args) {
  const logPath = path.join(LOGS_DIR, `${currentTeam || "scraper"}.log`);
  const line = `[${ts()}] [${level}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
  try { fs.appendFileSync(logPath, line, "utf8"); } catch {}
}

console.log   = (...a) => { appendLog("INFO",  a); _log(...a);   };
console.error = (...a) => { appendLog("ERROR", a); _error(...a); };
console.warn  = (...a) => { appendLog("WARN",  a); _warn(...a);  };

// ── GID counter ───────────────────────────────────────────────────────────────

// Synchronous read–increment–write: safe because there is no await between steps,
// so no other coroutine can interleave in Node.js's single-threaded event loop.
function claimGidBlock(count) {
  const data = safeReadJson(GID_COUNTER_PATH);
  const start = (data?.next && Number.isFinite(data.next)) ? data.next : 1;
  fs.writeFileSync(GID_COUNTER_PATH, JSON.stringify({ next: start + count }, null, 2), "utf8");
  return start;
}

// ── Shared meta ───────────────────────────────────────────────────────────────

function emptyMeta() {
  return {
    version:     1,
    updatedAt:   ts(),
    assignments: null,
    categories:  {},
    totals: {
      arda:     { done: 0, total: 0, reviews: 0, failed: 0 },
      tugce:    { done: 0, total: 0, reviews: 0, failed: 0 },
      havvagul: { done: 0, total: 0, reviews: 0, failed: 0 },
    },
  };
}

function loadSharedMeta()    { return safeReadJson(SHARED_META_PATH) || emptyMeta(); }
function saveSharedMeta(meta) { meta.updatedAt = ts(); safeWriteJson(SHARED_META_PATH, meta); }

// ── Team assignment generation ────────────────────────────────────────────────

function generateTeamAssignments() {
  console.log("[ASSIGNMENTS] Building balanced assignments from product_ids/...");
  if (!fs.existsSync(PRODUCT_IDS_DIR)) return { arda: [], tugce: [], havvagul: [] };

  const files = fs.readdirSync(PRODUCT_IDS_DIR)
    .filter(f => f.endsWith("_ids.json") && !f.includes(".partial."));

  const categories = files.flatMap(file => {
    const payload = safeReadJson(path.join(PRODUCT_IDS_DIR, file));
    if (!payload) return [];
    const slug  = sanitize(payload.slug || file.replace(/_ids\.json$/i, ""));
    const count = payload.uniqueCount
      || (Array.isArray(payload.products) ? payload.products.length : 0);
    return slug && count > 0 ? [{ slug, count }] : [];
  });

  categories.sort((a, b) => b.count - a.count); // heaviest first → better balance

  const loads      = { arda: 0, tugce: 0, havvagul: 0 };
  const result     = { arda: [], tugce: [], havvagul: [] };

  for (const cat of categories) {
    const lightest = Object.entries(loads).sort((a, b) => a[1] - b[1])[0][0];
    result[lightest].push(cat.slug);
    loads[lightest] += cat.count;
  }

  _log(`[ASSIGNMENTS] arda=${result.arda.length} tugce=${result.tugce.length} havvagul=${result.havvagul.length} categories`);
  _log(`[ASSIGNMENTS] product-load: arda=${loads.arda} tugce=${loads.tugce} havvagul=${loads.havvagul}`);
  return result;
}

function getOrCreateAssignments(meta) {
  if (meta.assignments && TEAMS.every(t => Array.isArray(meta.assignments[t]))) {
    return meta.assignments;
  }
  meta.assignments = generateTeamAssignments();
  return meta.assignments;
}

// ── User state ────────────────────────────────────────────────────────────────

const getUserStatePath = user => path.join(LOGS_DIR, `state_${sanitize(user)}.json`);

function loadUserState(user) {
  return safeReadJson(getUserStatePath(user)) || {
    user,
    lastRunAt:      null,
    runType:        null,
    failedJobs:     [],
    inProgressSlugs:[],
    sessionReviews: 0,
    sessionDone:    0,
  };
}

const saveUserState = state => safeWriteJson(getUserStatePath(state.user), state);

// ── Output path helpers ───────────────────────────────────────────────────────

function rawDir(slug)      { const d = path.join(RAW_DATA_DIR, sanitize(slug));      ensureDir(d); return d; }
function excludedDir(slug) { const d = path.join(EXCLUDED_DATA_DIR, sanitize(slug)); ensureDir(d); return d; }

const reviewOutputPath  = (slug, pid) => path.join(rawDir(slug),      `${sanitize(pid)}_reviews.json`);
const partialOutputPath = (slug, pid) => path.join(rawDir(slug),      `${sanitize(pid)}_reviews.partial.json`);
const excludedOutputPath= (slug, pid) => path.join(excludedDir(slug), `${sanitize(pid)}_excluded.json`);

// ── URL builders ──────────────────────────────────────────────────────────────

function buildReviewPageUrl(productUrl) {
  const base = (productUrl || "").split("?")[0].replace(/\/+$/, "");
  return `https://www.trendyol.com${base}/yorumlar`;
}

function buildReviewApiUrl(productId, pageNum) {
  const u = new URL(REVIEW_API_BASE);
  u.searchParams.set("contentId", String(productId));
  u.searchParams.set("page",      String(pageNum));
  u.searchParams.set("pageSize",  String(PAGE_SIZE));
  u.searchParams.set("order",     "DESC");
  u.searchParams.set("orderBy",   "Score");
  u.searchParams.set("channelId", "1");
  return u.toString();
}

// ── Schema transform ──────────────────────────────────────────────────────────

function computeRatingScore(raw) {
  const val = raw.rate ?? raw.score ?? raw.starCount ?? null;
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n * 20) : null; // 1-5 stars → 0-100
}

function transformReview(raw, productId, categorySlug, gid) {
  return {
    gid,
    rid:              String(raw.contentId ?? raw.id ?? ""),
    pid:              String(productId),
    seller:           raw.sellerName      ?? raw.merchantName    ?? null,
    comment:          raw.comment         ?? raw.text            ?? raw.reviewText ?? null,
    rating_score:     computeRatingScore(raw),
    timestamp:        raw.createdAt       ? new Date(Number(raw.createdAt)).toISOString()      : null,
    customer_name:    raw.userFullName    ?? raw.maskedBuyerName ?? null,
    helpful_votes:    raw.likesCount      ?? raw.helpfulVoteCount ?? 0,
    useless_votes:    null,
    image_count:      Array.isArray(raw.images) ? raw.images.length : (raw.imageCount ?? 0),
    resolved:         null,
    category:         categorySlug,
    platform:         "trendyol",
    modifiedDate:     raw.lastModifiedAt  ? new Date(Number(raw.lastModifiedAt)).toISOString() : null,
    label:            null,
    label_confidence: null,
    is_elite:         raw.isElite         ?? false,
    is_influencer:    raw.isInfluencer    ?? false,
    is_verified:      raw.trusted         ?? raw.isVerified ?? false,
    trusted:          raw.trusted         ?? false,
  };
}

function extractExcludedFields(raw, gid) {
  const excluded = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!SCHEMA_SOURCE_KEYS.has(k)) excluded[k] = v;
  }
  if (Object.keys(excluded).length === 0) return null;
  return { gid_ref: gid, reason: "excluded_fields", platform: "trendyol", data: excluded };
}

// ── Review response parsing (lenient — tries multiple shapes) ─────────────────

function parseReviewResponse(json) {
  const result     = json?.result ?? json;
  const list       = result?.productReviews ?? result?.reviewDetails ?? result?.reviews ?? result?.content ?? [];
  return {
    list:        Array.isArray(list) ? list : [],
    totalCount:  result?.totalCount  ?? result?.total    ?? null,
    hasNextPage: result?.hasNextPage ?? null,
    pageCount:   result?.pageCount   ?? null,
  };
}

// ── Partial state helpers ─────────────────────────────────────────────────────

function loadPartialState(slug, productId) {
  const p = partialOutputPath(slug, productId);
  if (!fs.existsSync(p)) return null;
  const data = safeReadJson(p);
  if (!data?.partial) return null;

  const byReviewId = new Map();
  for (const r of (data.rawReviews || [])) {
    const k = String(r.contentId ?? r.id ?? "");
    if (k) byReviewId.set(k, r);
  }
  return { byReviewId, lastPage: data.lastPage || 0, totalCount: data.totalCount || null };
}

function savePartialState(slug, productId, productUrl, state) {
  safeWriteJson(partialOutputPath(slug, productId), {
    categorySlug:   slug,
    productId,
    productUrl,
    partial:        true,
    collectedAt:    ts(),
    lastPage:       state.lastPage,
    totalCount:     state.totalCount,
    rawReviewCount: state.byReviewId.size,
    rawReviews:     Array.from(state.byReviewId.values()),
  });
}

// ── Save final result ─────────────────────────────────────────────────────────

function saveFinalResult(job, state) {
  const { categorySlug, productId, productUrl } = job;
  const rawList  = Array.from(state.byReviewId.values());
  const gidStart = claimGidBlock(rawList.length || 1); // claim at least 1 even for zero-review products

  const reviews         = [];
  const excludedEntries = [];

  for (let i = 0; i < rawList.length; i++) {
    const gid = gidStart + i;
    reviews.push(transformReview(rawList[i], productId, categorySlug, gid));
    const excl = extractExcludedFields(rawList[i], gid);
    if (excl) excludedEntries.push(excl);
  }

  safeWriteJson(reviewOutputPath(categorySlug, productId), {
    categorySlug,
    productId,
    productUrl,
    collectedAt:  ts(),
    platform:     "trendyol",
    reviewCount:  reviews.length,
    reviews,
  });

  if (excludedEntries.length > 0) {
    safeWriteJson(excludedOutputPath(categorySlug, productId), excludedEntries);
  }

  const partial = partialOutputPath(categorySlug, productId);
  if (fs.existsSync(partial)) fs.unlinkSync(partial);

  const gidEnd = gidStart + reviews.length - 1;
  console.log(`[REVIEW SAVED] ${categorySlug}/${productId} (${reviews.length} reviews, gid ${gidStart}–${gidEnd})`);
  return reviews.length;
}

// ── Meta update helpers ───────────────────────────────────────────────────────

function metaAfterSave(slug, team, reviewCount) {
  const meta = loadSharedMeta();
  if (meta.categories[slug]) {
    meta.categories[slug].done    += 1;
    meta.categories[slug].reviews += reviewCount;
    meta.categories[slug].lastUpdated = ts();
  }
  if (meta.totals[team]) {
    meta.totals[team].done    += 1;
    meta.totals[team].reviews += reviewCount;
  }
  saveSharedMeta(meta);
  return meta;
}

function metaAfterFail(slug, team) {
  const meta = loadSharedMeta();
  if (meta.categories[slug]) meta.categories[slug].failed = (meta.categories[slug].failed || 0) + 1;
  if (meta.totals[team])     meta.totals[team].failed     = (meta.totals[team].failed     || 0) + 1;
  saveSharedMeta(meta);
}

// ── API fetch ─────────────────────────────────────────────────────────────────

async function fetchReviewPage(page, productId, pageNum) {
  const url = buildReviewApiUrl(productId, pageNum);
  return page.evaluate(async (apiUrl) => {
    const res  = await fetch(apiUrl, {
      credentials: "include",
      headers: {
        "Accept":           "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json };
  }, url);
}

async function fetchWithRetry(page, productId, pageNum) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const payload = await fetchReviewPage(page, productId, pageNum);
      if (!payload.ok) throw new Error(`HTTP ${payload.status} page=${pageNum}`);
      const parsed = parseReviewResponse(payload.json);
      if (!Array.isArray(parsed.list)) throw new Error(`Bad response shape page=${pageNum}`);
      return { ...payload, parsed };
    } catch (err) {
      lastErr = err;
      console.warn(`[retry] productId=${productId} page=${pageNum} attempt=${attempt}/${RETRY_ATTEMPTS}`);
      if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr || new Error(`All retries failed productId=${productId} page=${pageNum}`);
}

// ── Review collection per product ─────────────────────────────────────────────

async function collectReviews(page, job) {
  const { categorySlug, productId, productUrl } = job;
  const partial = loadPartialState(categorySlug, productId);

  const state = {
    byReviewId: partial?.byReviewId || new Map(),
    lastPage:   partial?.lastPage   || 0,
    totalCount: partial?.totalCount || null,
  };
  const startPage = state.lastPage + 1;

  if (partial) {
    console.log(`[RESUME] ${categorySlug}/${productId} from page=${startPage} (${state.byReviewId.size} already collected)`);
  }

  activeReviewRuns.set(`${categorySlug}:${productId}`, { job, state });
  console.log(`\n[START REVIEW] category=${categorySlug} productId=${productId} startPage=${startPage}`);

  for (let p = startPage; p <= REVIEW_MAX_PAGES; p++) {
    if (isShuttingDown) break;

    const { parsed } = await fetchWithRetry(page, productId, p);
    state.lastPage = p;
    if (parsed.totalCount != null) state.totalCount = parsed.totalCount;

    for (const raw of parsed.list) {
      const k = String(raw.contentId ?? raw.id ?? "");
      if (k && !state.byReviewId.has(k)) state.byReviewId.set(k, raw);
    }

    console.log(`[review ${categorySlug}/${productId}] page=${p} +${parsed.list.length} (unique=${state.byReviewId.size}/${state.totalCount ?? "?"})`);

    if (p % CHECKPOINT_EVERY === 0) savePartialState(categorySlug, productId, productUrl, state);

    const reachedTotal = state.totalCount != null && state.byReviewId.size >= state.totalCount;
    const noMore       = parsed.list.length === 0 || parsed.hasNextPage === false;
    const lastByCount  = parsed.pageCount != null  && p >= parsed.pageCount;
    if (reachedTotal || noMore || lastByCount) break;

    await sleep(REVIEW_DELAY_MS + Math.floor(Math.random() * 150));
  }

  activeReviewRuns.delete(`${categorySlug}:${productId}`);
  return state;
}

async function processReview(page, job) {
  await page.goto(buildReviewPageUrl(job.productUrl), {
    waitUntil: "domcontentloaded",
    timeout:   60000,
  });
  await sleep(1000);

  const state = await collectReviews(page, job);
  return saveFinalResult(job, state);
}

// ── Worker pool ───────────────────────────────────────────────────────────────

async function runWorkers(context, jobs, concurrency) {
  const queue = [...jobs];

  async function worker(workerId) {
    let page = await context.newPage();
    page.setDefaultNavigationTimeout(60000);
    let consecutiveErrors = 0;

    try {
      while (queue.length > 0) {
        if (isShuttingDown) { console.log(`[WORKER ${workerId}] shutdown, exiting.`); return; }

        const job = queue.shift();
        if (!job) break;
        const { categorySlug, productId } = job;

        if (fs.existsSync(reviewOutputPath(categorySlug, productId))) {
          console.log(`[WORKER ${workerId}] skip existing ${categorySlug}/${productId}`);
          continue;
        }

        console.log(`\n[WORKER ${workerId}] starting ${categorySlug}/${productId}`);

        try {
          const reviewCount = await processReview(page, job);
          consecutiveErrors = 0;
          sharedMeta = metaAfterSave(categorySlug, currentTeam, reviewCount);
          userState.sessionDone++;
          userState.sessionReviews += reviewCount;
          saveUserState(userState);
        } catch (err) {
          consecutiveErrors++;
          console.error(`[REVIEW ERROR] ${categorySlug}/${productId}`);
          console.error(err);
          userState.failedJobs.push({
            categorySlug, productId, productUrl: job.productUrl,
            error: String(err?.stack || err?.message || err),
            recordedAt: ts(),
          });
          saveUserState(userState);
          metaAfterFail(categorySlug, currentTeam);

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.log(`[WORKER ${workerId}] recycling page after ${consecutiveErrors} errors`);
            try { if (!page.isClosed()) await page.close().catch(() => {}); } catch {}
            page = await context.newPage();
            page.setDefaultNavigationTimeout(60000);
            consecutiveErrors = 0;
          }
        }
      }
    } finally {
      try { if (!page.isClosed()) await page.close().catch(() => {}); } catch {}
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
}

// ── Job loaders ───────────────────────────────────────────────────────────────

function loadJobsForSlugs(slugs, options) {
  const slugSet = new Set(slugs);
  const jobs    = [];

  if (!fs.existsSync(PRODUCT_IDS_DIR)) return jobs;

  for (const file of fs.readdirSync(PRODUCT_IDS_DIR).filter(f => f.endsWith("_ids.json") && !f.includes(".partial."))) {
    const payload = safeReadJson(path.join(PRODUCT_IDS_DIR, file));
    if (!payload) continue;
    const slug = sanitize(payload.slug || file.replace(/_ids\.json$/i, ""));
    if (!slugSet.has(slug)) continue;
    if (options.categories && !options.categories.has(slug)) continue;

    // Optional: skip fully-done categories from meta to save startup time
    if (options.incompleteOnly && sharedMeta.categories[slug]) {
      const cat = sharedMeta.categories[slug];
      if (cat.done >= cat.productCount && cat.productCount > 0) continue;
    }

    for (const prod of (Array.isArray(payload.products) ? payload.products : [])) {
      const productId  = String(prod.id ?? "").trim();
      const productUrl = typeof prod.url === "string" ? prod.url : "";
      if (!productId || !productUrl) continue;
      if (options.products && !options.products.has(productId)) continue;
      jobs.push({ categorySlug: slug, productId, productUrl });
    }
  }
  return jobs;
}

function loadFailedJobs(user, options) {
  const state = loadUserState(user);
  return state.failedJobs
    .filter(j => {
      if (!j.categorySlug || !j.productId || !j.productUrl) return false;
      if (options.categories && !options.categories.has(j.categorySlug)) return false;
      if (options.products   && !options.products.has(j.productId))      return false;
      return true;
    })
    .map(j => ({ categorySlug: j.categorySlug, productId: j.productId, productUrl: j.productUrl }));
}

function loadPartialJobs(slugs) {
  const jobs = [];
  if (!fs.existsSync(RAW_DATA_DIR)) return jobs;

  for (const slug of slugs) {
    const catDir = path.join(RAW_DATA_DIR, sanitize(slug));
    if (!fs.existsSync(catDir)) continue;
    for (const file of fs.readdirSync(catDir)) {
      if (!file.endsWith("_reviews.partial.json")) continue;
      const pidSanitized = file.replace("_reviews.partial.json", "");
      const idFile       = path.join(PRODUCT_IDS_DIR, `${slug}_ids.json`);
      const payload      = safeReadJson(idFile);
      const prod = Array.isArray(payload?.products)
        ? payload.products.find(p => sanitize(String(p.id)) === pidSanitized)
        : null;
      if (prod) jobs.push({ categorySlug: slug, productId: String(prod.id), productUrl: prod.url });
    }
  }
  return jobs;
}

// ── CLI parsing ───────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const opts = {
    user:          null,
    team:          null,
    categories:    null,
    products:      null,
    concurrency:   REVIEW_CONCURRENCY,
    failedOnly:    false,
    partialOnly:   false,
    incompleteOnly:false,
    timeLimitMs:   null,
    name:          null,
  };

  for (const arg of argv) {
    if      (arg.startsWith("--user="))        opts.user          = sanitize(arg.slice(7).trim()).toLowerCase() || null;
    else if (arg.startsWith("--team="))        opts.team          = sanitize(arg.slice(7).trim()).toLowerCase() || null;
    else if (arg.startsWith("--name="))        opts.name          = sanitize(arg.slice(7).trim()) || null;
    else if (arg === "--failed-only")          opts.failedOnly    = true;
    else if (arg === "--partial-only")         opts.partialOnly   = true;
    else if (arg === "--incomplete-only")      opts.incompleteOnly= true;
    else if (arg.startsWith("--categories="))  opts.categories    = new Set(arg.slice(13).split(",").map(x => sanitize(x.trim())).filter(Boolean));
    else if (arg.startsWith("--products="))    opts.products      = new Set(arg.slice(11).split(",").map(x => x.trim()).filter(Boolean));
    else if (arg.startsWith("--concurrency=")) {
      const n = Number(arg.slice(14));
      if (Number.isFinite(n) && n > 0) opts.concurrency = Math.floor(n);
    }
    else if (arg.startsWith("--time-limit=")) {
      const mins = Number(arg.slice(13));
      if (Number.isFinite(mins) && mins > 0) opts.timeLimitMs = mins * 60 * 1000;
    }
  }

  return opts;
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

function triggerShutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (shutdownTimerId) { clearTimeout(shutdownTimerId); shutdownTimerId = null; }
  console.log(`\n[SHUTDOWN] ${reason}. Saving in-progress partials...`);
  for (const [, run] of activeReviewRuns.entries()) {
    try { savePartialState(run.job.categorySlug, run.job.productId, run.job.productUrl, run.state); }
    catch (e) { console.error("[SHUTDOWN] partial save failed", e); }
  }
}

process.on("SIGINT", () => triggerShutdown("SIGINT"));

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const opts = parseCliArgs(process.argv.slice(2));

  // Resolve user/team
  const user = opts.user || opts.team;
  if (!user || !TEAMS.includes(user)) {
    _error(`[ERROR] --user=<${TEAMS.join("|")}> is required.`);
    process.exit(1);
  }
  currentTeam = opts.team || user;

  // Shared meta + assignment generation (one-time if needed)
  sharedMeta = loadSharedMeta();
  const assignments = getOrCreateAssignments(sharedMeta);
  const teamSlugs   = assignments[currentTeam] || [];

  // Seed category entries into meta for any new slugs
  let metaDirty = !safeReadJson(SHARED_META_PATH)?.assignments;
  for (const slug of teamSlugs) {
    if (!sharedMeta.categories[slug]) {
      const payload = safeReadJson(path.join(PRODUCT_IDS_DIR, `${slug}_ids.json`));
      const count   = payload?.uniqueCount || (Array.isArray(payload?.products) ? payload.products.length : 0);
      sharedMeta.categories[slug] = { team: currentTeam, productCount: count, done: 0, reviews: 0, failed: 0, lastUpdated: null };
      sharedMeta.totals[currentTeam].total += count;
      metaDirty = true;
    }
  }
  if (metaDirty) saveSharedMeta(sharedMeta);

  // User state
  userState = loadUserState(user);
  userState.lastRunAt      = ts();
  userState.sessionReviews = 0;
  userState.sessionDone    = 0;

  // Job loading
  let jobs    = [];
  let runType = "normal";

  if (opts.failedOnly) {
    runType = "failed-retry";
    jobs    = loadFailedJobs(user, opts);
    console.log(`[RUN] mode=failed-retry user=${user} jobs=${jobs.length}`);
  } else if (opts.partialOnly) {
    runType = "partial-sweep";
    jobs    = loadPartialJobs(teamSlugs);
    console.log(`[RUN] mode=partial-sweep user=${user} jobs=${jobs.length}`);
  } else {
    runType = "normal";
    jobs    = loadJobsForSlugs(teamSlugs, opts);
    console.log(`[RUN] mode=normal user=${user} team=${currentTeam} jobs=${jobs.length} concurrency=${opts.concurrency}`);
  }

  userState.runType         = runType;
  userState.inProgressSlugs = [...new Set(jobs.map(j => j.categorySlug))];
  if (runType !== "failed-retry") userState.failedJobs = [];
  saveUserState(userState);

  if (jobs.length === 0) { console.log("[RUN] No jobs. Exiting."); return; }

  if (opts.timeLimitMs) {
    const mins = Math.round(opts.timeLimitMs / 60000);
    console.log(`[RUN] time-limit=${mins}m`);
    shutdownTimerId = setTimeout(() => triggerShutdown(`Time limit (${mins}m) reached`), opts.timeLimitMs);
  }

  console.log(`[RUN] Starting workers...`);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args:     ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1280, height: 720 },
  });

  try {
    await runWorkers(context, jobs, opts.concurrency);
    console.log(`\n[RUN DONE] mode=${runType} done=${userState.sessionDone} reviews=${userState.sessionReviews} failed=${userState.failedJobs.length}`);
    if (userState.failedJobs.length > 0) {
      console.log(`[RUN DONE] ${userState.failedJobs.length} failed job(s) recorded in logs/state_${user}.json`);
    }
  } catch (err) {
    console.error("[FATAL]", err);
  } finally {
    if (shutdownTimerId) clearTimeout(shutdownTimerId);
    saveUserState(userState);
    saveSharedMeta(sharedMeta);
    await context.close().catch(() => {});
  }
})();
