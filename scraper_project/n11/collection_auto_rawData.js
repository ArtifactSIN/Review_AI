const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PRODUCT_IDS_DIR = path.join(__dirname, "product_ids");
const RAW_DATA_DIR = path.join(__dirname, "raw_data");
const LOGS_DIR = path.join(__dirname, "logs");

const REVIEW_CONCURRENCY = 3;
const REVIEW_DELAY_MS = 350;
const REVIEW_MAX_PAGES = 500;
const REVIEW_SORT_ORDER = "RECENT";
const REVIEW_TAG = "tümü";
const CHECKPOINT_EVERY_PAGES = 5;
const REVIEW_RETRY_ATTEMPTS = 3;
const REVIEW_RETRY_DELAY_MS = 1200;
const MAX_CONSECUTIVE_WORKER_ERRORS = 5;

let isShuttingDown = false;
const activeReviewRuns = new Map();
const failedJobsLatestPath = path.join(LOGS_DIR, `failed_jobs_latest.json`);
const statusFilePath = path.join(LOGS_DIR, `current_status.json`);

const TEAM_ASSIGNMENTS = {
  arda: [
    "kitap",
    "dekorasyon-ve-aydinlatma",
    "telefon-ve-aksesuarlari",
    "ses-sistemleri-ve-navigasyon",
    "motosiklet",
    "kadin-bakim-urunleri",
    "su-sporlari",
    "yuz-ve-vucut-bakimi",
    "cinsel-urunler",
    "beslenme-ve-mama-sandalyesi",
    "bilgisayar",
    
    "bebek-giyim",
    "bireysel-ve-takim-sporlari",
    "emzirme-urunleri",
    "guzellik-salonu-ve-kuafor-urunleri",
    "kis-sporlari",
    
  ],
  tugce: [
    "kadin-giyim-aksesuar",
    "outdoor-ve-kamp",
    "erkek-giyim-aksesuar",
    "evcil-hayvan-urunleri",
    "yedek-parca-otomobil",
    "bisiklet-ve-scooter",
    "elektrikli-ev-aletleri",
    "lastik-ve-jant",
    "mutfak-gerecleri",
    "spor-giyim-ve-ayakkabi",
    "avcilik-ve-balikcilik",
    "erkek-bakim-urunleri",
    "mobilya",
    "bebek-bezi-ve-islak-mendil",
    "biberon-ve-aksesuarlari",
    "dugun-davet-organizasyon",
    "fotograf-ve-kamera",
    "ilginc-akilli-urunler",
    "tekne-ve-yat-malzemeleri"
  ],
  havvagul: [
    "parfum-ve-deodorant",
    "saglik-ve-medikal-urunler",
    "ev-tekstili",
    "kirtasiye-ve-ofis",
    "beyaz-esya",
    "yetiskin-hobi-ve-oyun",
    "muzik",
    "sac-bakim-ve-sekillendirme",
    "bebek-odasi-ve-park-yatak",
    "makyaj",
    "cocuk-oyuncaklari-ve-parti",
    "fitness-ve-kondisyon",
    "yapi-market-ve-bahce",
    "bebek-guvenlik",
    "dijital-kodlar-urunler",
    "film",
    "hamile-giyim",
    "oto-koltugu-ve-ana-kucagi",
    "yurutec-ve-yurume-yardimcilari",
    "yasam-ve-etkinlik"
  ],
};

function getAllCategorySlugsFromProductIds() {
  if (!fs.existsSync(PRODUCT_IDS_DIR)) return [];

  return fs.readdirSync(PRODUCT_IDS_DIR)
    .filter(file => file.endsWith(".json") && !file.endsWith(".partial.json"))
    .map(file => {
      const fullPath = path.join(PRODUCT_IDS_DIR, file);
      try {
        const payload = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        let slug = sanitizeFileName(payload?.slug || file.replace(/_ids\.json$/i, "").replace(/\.json$/i, ""));
        return slug;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort();
}

function isCategoryCompleted(categorySlug) {
  const productIdFile = path.join(PRODUCT_IDS_DIR, `${categorySlug}_ids.json`);

  if (!fs.existsSync(productIdFile)) {
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(productIdFile, "utf8"));
  } catch {
    return false;
  }

  const ids = Array.isArray(payload?.ids)
    ? payload.ids
    : Array.isArray(payload)
      ? payload
      : [];

  if (ids.length === 0) return false;

  for (const rawId of ids) {
    const productId = String(rawId).trim();
    if (!productId) continue;

    const finalPath = getReviewOutputPath(categorySlug, productId);
    if (!fs.existsSync(finalPath)) {
      return false;
    }
  }

  return true;
}

function getCategoryProductCount(categorySlug) {
  const productIdFile = path.join(PRODUCT_IDS_DIR, `${categorySlug}_ids.json`);

  if (!fs.existsSync(productIdFile)) {
    return 0;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(productIdFile, "utf8"));
    const ids = Array.isArray(payload?.ids)
      ? payload.ids
      : Array.isArray(payload)
        ? payload
        : [];

    return ids.length;
  } catch {
    return 0;
  }
}

function buildBalancedTeamAssignments() {
  const teamLoads = {
    arda: { totalProducts: 0, categories: [] },
    tugce: { totalProducts: 0, categories: [] },
    havvagul: { totalProducts: 0, categories: [] },
  };

  const remainingCategories = getRemainingCategories()
    .map(categorySlug => ({
      categorySlug,
      productCount: getCategoryProductCount(categorySlug),
    }))
    .sort((a, b) => b.productCount - a.productCount);

  for (const item of remainingCategories) {
    const lightestTeam = Object.entries(teamLoads)
      .sort((a, b) => a[1].totalProducts - b[1].totalProducts)[0][0];

    teamLoads[lightestTeam].categories.push(item.categorySlug);
    teamLoads[lightestTeam].totalProducts += item.productCount;
  }

  return teamLoads;
}

function printBalancedTeamAssignments() {
  const assignments = buildBalancedTeamAssignments();

  console.log("\n[BALANCED TEAM ASSIGNMENTS]");
  for (const [teamName, info] of Object.entries(assignments)) {
    console.log(`\n${teamName.toUpperCase()} | totalProducts=${info.totalProducts}`);
    console.log(info.categories.join(", "));
  }
}

function getCompletedCategories() {
  const allCategories = getAllCategorySlugsFromProductIds();
  return new Set(allCategories.filter(isCategoryCompleted));
}

function getRemainingCategories() {
  const allCategories = getAllCategorySlugsFromProductIds();
  const completed = getCompletedCategories();
  return allCategories.filter(categorySlug => !completed.has(categorySlug));
}

let activeRunId = null;
let logFilePath = null;
let summaryFilePath = null;
let failedJobsRunFilePath = null;

const runStats = {
  runId: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  totalJobsQueued: 0,
  completed: 0,
  skippedExisting: 0,
  failed: 0,
  partialSaved: 0,
  resumedFromPartial: 0,
  zeroReviewProducts: 0,
  totalReviewsCollected: 0,
  activeWorkers: 0,
  filters: {
    categories: null,
    products: null,
    concurrency: REVIEW_CONCURRENCY,
    failedOnly: false,
    failedFile: null,
  }
};

const failedJobs = [];

for (const dir of [RAW_DATA_DIR, LOGS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function appendLogLine(level, args) {
  if (!logFilePath) return;
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatLogArg).join(" ")}\n`;
  fs.appendFileSync(logFilePath, line, "utf8");
}

function formatLogArg(arg) {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

console.log = (...args) => {
  appendLogLine("INFO", args);
  originalConsoleLog(...args);
};

console.error = (...args) => {
  appendLogLine("ERROR", args);
  originalConsoleError(...args);
};

console.warn = (...args) => {
  appendLogLine("WARN", args);
  originalConsoleWarn(...args);
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFileName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "output";
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parseCliArgs(argv) {
  const options = {
    categories: null,
    products: null,
    concurrency: REVIEW_CONCURRENCY,
    failedOnly: false,
    failedFile: null,
    listRuns: false,
    resumeRun: null,
    name: null,
    listAllRuns: false,
    team: null,
    teamCategoryLimit: null,
  };

  for (const arg of argv) {
    if (arg.startsWith("--categories=")) {
      options.categories = new Set(
        arg
          .slice("--categories=".length)
          .split(",")
          .map(x => sanitizeFileName(x.trim()))
          .filter(Boolean)
      );
    } else if (arg.startsWith("--products=")) {
      options.products = new Set(
        arg
          .slice("--products=".length)
          .split(",")
          .map(x => String(x).trim())
          .filter(Boolean)
      );
    } else if (arg.startsWith("--concurrency=")) {
      const n = Number(arg.slice("--concurrency=".length));
      if (Number.isFinite(n) && n > 0) {
        options.concurrency = Math.floor(n);
      }
    } else if (arg === "--failed-only") {
      options.failedOnly = true;
    } else if (arg.startsWith("--failed-file=")) {
      options.failedFile = arg.slice("--failed-file=".length).trim() || null;
    } else if (arg === "--list-runs") {
      options.listRuns = true;
    } else if (arg.startsWith("--resume-run=")) {
      options.resumeRun = arg.slice("--resume-run=".length).trim() || null;
    } else if (arg.startsWith("--name=")) {
      options.name = sanitizeFileName(arg.slice("--name=".length).trim()) || null;
    } else if (arg === "--list-all-runs") {
      options.listAllRuns = true;
    } else if (arg.startsWith("--team=")) {
      options.team = sanitizeFileName(arg.slice("--team=".length).trim()).toLowerCase() || null;
    } else if (/^\d+$/.test(arg)) {
      const n = Number(arg);
      if (Number.isFinite(n) && n > 0) {
        options.teamCategoryLimit = Math.floor(n);
      }
    }
  }

  return options;
}

function resolveTeamCategories(teamName, limit = null) {
  const normalizedTeam = sanitizeFileName(teamName || "").toLowerCase();
  const assigned = TEAM_ASSIGNMENTS[normalizedTeam];

  if (!assigned) {
    throw new Error(`Unknown team name: ${teamName}`);
  }

  const assignedSet = new Set(assigned.map(x => sanitizeFileName(x)));
  const remaining = getRemainingCategories().filter(category => assignedSet.has(category));

  return Number.isFinite(limit) && limit > 0
    ? remaining.slice(0, limit)
    : remaining;
}

function makeRunId(name, kind = "normal") {
  const baseName = sanitizeFileName(name || "review-run");
  if (kind === "failed-only") {
    return `${baseName}_failed_only`;
  }
  return baseName;
}

function configureRunFiles(runId) {
  activeRunId = runId;
  runStats.runId = runId;
  logFilePath = path.join(LOGS_DIR, `${runId}.log`);
  summaryFilePath = path.join(LOGS_DIR, `${runId}_summary.json`);
  failedJobsRunFilePath = path.join(LOGS_DIR, `${runId}_failed_jobs.json`);
}

function buildReviewPageUrl(productId) {
  return `https://www.n11.com/product-reviews/${productId}`;
}

function buildReviewApiUrl(productId, currentPage) {
  const url = new URL(`https://www.n11.com/getProductReviews/${productId}`);
  url.searchParams.set("currentPage", String(currentPage));
  url.searchParams.set("sortOrder", REVIEW_SORT_ORDER);
  url.searchParams.set("tag", REVIEW_TAG);
  return url.toString();
}

function getCategoryOutputDir(categorySlug) {
  const dir = path.join(RAW_DATA_DIR, sanitizeFileName(categorySlug));
  ensureDir(dir);
  return dir;
}

function getReviewOutputPath(categorySlug, productId) {
  return path.join(getCategoryOutputDir(categorySlug), `${sanitizeFileName(productId)}_reviews.json`);
}

function getPartialReviewOutputPath(categorySlug, productId) {
  return path.join(getCategoryOutputDir(categorySlug), `${sanitizeFileName(productId)}_reviews.partial.json`);
}

function writeFailedJobsFiles() {
  const payload = {
    runId: activeRunId,
    updatedAt: new Date().toISOString(),
    failedCount: failedJobs.length,
    jobs: failedJobs,
  };

  fs.writeFileSync(failedJobsRunFilePath, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(failedJobsLatestPath, JSON.stringify(payload, null, 2), "utf8");
}

function recordFailedJob(job, error, extra = {}) {
  const { categorySlug, productId } = job;
  failedJobs.push({
    categorySlug,
    productId,
    error: error ? String(error?.stack || error?.message || error) : "Unknown error",
    recordedAt: new Date().toISOString(),
    ...extra,
  });
  runStats.failed += 1;
  writeFailedJobsFiles();
}

function writeRunSummary() {
  const payload = {
    ...runStats,
    failedJobsFile: failedJobsRunFilePath,
    logFile: logFilePath,
  };
  fs.writeFileSync(summaryFilePath, JSON.stringify(payload, null, 2), "utf8");
}

function writeCurrentStatus(extra = {}) {
  const active = Array.from(activeReviewRuns.entries()).map(([, activeRun]) => ({
    categorySlug: activeRun.categorySlug,
    productId: activeRun.productId,
    pagesSeen: Array.from(activeRun.state.pagesSeen).sort((a, b) => a - b),
    reviewCountUnique: activeRun.state.byReviewId.size,
  }));

  const payload = {
    runId: activeRunId,
    updatedAt: new Date().toISOString(),
    isShuttingDown,
    totals: {
      totalJobsQueued: runStats.totalJobsQueued,
      completed: runStats.completed,
      skippedExisting: runStats.skippedExisting,
      failed: runStats.failed,
      partialSaved: runStats.partialSaved,
      resumedFromPartial: runStats.resumedFromPartial,
      zeroReviewProducts: runStats.zeroReviewProducts,
      totalReviewsCollected: runStats.totalReviewsCollected,
      activeWorkers: runStats.activeWorkers,
    },
    filters: runStats.filters,
    active,
    ...extra,
  };

  fs.writeFileSync(statusFilePath, JSON.stringify(payload, null, 2), "utf8");
}

function loadJobsFromFailedFile(failedFilePath, options = {}) {
  const jobs = [];
  if (!failedFilePath || !fs.existsSync(failedFilePath)) {
    return jobs;
  }

  const payload = JSON.parse(fs.readFileSync(failedFilePath, "utf8"));
  const entries = Array.isArray(payload?.jobs) ? payload.jobs : [];

  for (const entry of entries) {
    const categorySlug = sanitizeFileName(entry?.categorySlug || "");
    const productId = String(entry?.productId || "").trim();
    if (!categorySlug || !productId) continue;

    if (options.categories && !options.categories.has(categorySlug)) continue;
    if (options.products && !options.products.has(productId)) continue;

    jobs.push({ categorySlug, productId });
  }

  return jobs;
}

function dedupeJobs(jobs) {
  const out = [];
  const seen = new Set();

  for (const job of jobs) {
    const key = `${job.categorySlug}:${job.productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(job);
  }

  return out;
}

function getReviewSummaryFiles() {
  if (!fs.existsSync(LOGS_DIR)) {
    return [];
  }

  return fs.readdirSync(LOGS_DIR)
    .filter(file => file.endsWith("_summary.json"))
    .map(file => path.join(LOGS_DIR, file))
    .sort();
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listPreviousRuns(includeCompleted = false) {
  const files = getReviewSummaryFiles();

  if (files.length === 0) {
    console.log("[RUNS] no previous summary files found.");
    return;
  }

  console.log(includeCompleted ? "[RUNS] all review runs:" : "[RUNS] previous incomplete review runs:");
  for (const filePath of files) {
    const summary = safeReadJson(filePath);
    if (!summary) continue;

    const total = Number(summary.totalJobsQueued || 0);
    const completed = Number(summary.completed || 0);
    const skippedExisting = Number(summary.skippedExisting || 0);
    const failed = Number(summary.failed || 0);
    const accounted = completed + skippedExisting + failed;
    const incomplete = Math.max(0, total - accounted);
    const show = includeCompleted || incomplete > 0 || summary.filters?.failedOnly;

    if (!show) continue;

    console.log(
      `- runId=${summary.runId} | startedAt=${summary.startedAt} | queued=${total} completed=${completed} skipped=${skippedExisting} failed=${failed} incomplete=${incomplete}${summary.filters?.failedOnly ? " | mode=failed-only" : ""}`
    );
  }
}

function resolveRunSummaryPath(resumeRun) {
  if (!resumeRun) {
    return null;
  }

  if (fs.existsSync(resumeRun)) {
    return resumeRun;
  }

  const candidate = path.join(LOGS_DIR, `${resumeRun}_summary.json`);
  if (fs.existsSync(candidate)) {
    return candidate;
  }

  return null;
}

function mergeResumeOptions(options, summary) {
  const merged = { ...options };
  const filters = summary?.filters || {};

  if (!merged.categories && Array.isArray(filters.categories)) {
    merged.categories = new Set(filters.categories.map(x => sanitizeFileName(x)).filter(Boolean));
  }

  if (!merged.products && Array.isArray(filters.products)) {
    merged.products = new Set(filters.products.map(x => String(x).trim()).filter(Boolean));
  }

  if ((!merged.concurrency || merged.concurrency === REVIEW_CONCURRENCY) &&
      Number.isFinite(filters.concurrency) &&
      filters.concurrency > 0) {
    merged.concurrency = Math.floor(filters.concurrency);
  }

  return merged;
}

function loadJobsForResumeRun(options) {
  const summaryPath = resolveRunSummaryPath(options.resumeRun);
  if (!summaryPath) {
    throw new Error(`Could not resolve resume run: ${options.resumeRun}`);
  }

  const summary = safeReadJson(summaryPath);
  if (!summary) {
    throw new Error(`Could not read run summary: ${summaryPath}`);
  }

  const mergedOptions = mergeResumeOptions({ ...options, name: summary?.runId || options.name }, summary);

  const allJobs = loadProductIdJobs({
    ...mergedOptions,
    failedOnly: false,
    failedFile: null,
    listRuns: false,
    resumeRun: null,
  });

  const pendingJobs = allJobs.filter(
    job => !fs.existsSync(getReviewOutputPath(job.categorySlug, job.productId))
  );

  return {
    summary,
    summaryPath,
    jobs: pendingJobs,
    mergedOptions,
  };
}

function loadProductIdJobs(options = {}) {
  if (options.failedOnly) {
    const failedPath = options.failedFile || failedJobsLatestPath;
    return dedupeJobs(loadJobsFromFailedFile(failedPath, options));
  }

  const jobs = [];

  if (!fs.existsSync(PRODUCT_IDS_DIR)) {
    return jobs;
  }

  const files = fs.readdirSync(PRODUCT_IDS_DIR)
    .filter(file => file.endsWith(".json") && !file.endsWith(".partial.json"));

  for (const file of files) {
    const fullPath = path.join(PRODUCT_IDS_DIR, file);
    const payload = JSON.parse(fs.readFileSync(fullPath, "utf8"));

    let categorySlug = sanitizeFileName(payload?.slug || file.replace(/_ids\.json$/i, ""));
    if (!categorySlug) {
      categorySlug = sanitizeFileName(file.replace(/\.json$/i, ""));
    }

    if (options.categories && !options.categories.has(categorySlug)) {
      continue;
    }

    const ids = Array.isArray(payload?.ids)
      ? payload.ids
      : Array.isArray(payload)
        ? payload
        : [];

    for (const rawId of ids) {
      const productId = String(rawId).trim();
      if (!productId) continue;

      if (options.products && !options.products.has(productId)) {
        continue;
      }

      jobs.push({
        categorySlug,
        productId,
      });
    }
  }

  return dedupeJobs(jobs);
}

function loadPartialReviewState(categorySlug, productId) {
  const partialPath = getPartialReviewOutputPath(categorySlug, productId);
  if (!fs.existsSync(partialPath)) {
    return null;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(partialPath, "utf8"));
    const byReviewId = new Map();

    if (Array.isArray(payload?.reviews)) {
      for (const review of payload.reviews) {
        if (review?.id == null) continue;
        byReviewId.set(String(review.id), review);
      }
    }

    const pagesSeen = new Set(
      Array.isArray(payload?.pagesSeen)
        ? payload.pagesSeen.map(Number).filter(Number.isFinite)
        : []
    );

    return {
      byReviewId,
      pagesSeen,
      meta: {
        sortOrder: payload?.meta?.sortOrder ?? REVIEW_SORT_ORDER,
        tag: payload?.meta?.tag ?? REVIEW_TAG,
        itemsPerPage: payload?.meta?.itemsPerPage ?? null,
        pageCount: payload?.meta?.pageCount ?? null,
        totalCount: payload?.meta?.totalCount ?? null,
      }
    };
  } catch (err) {
    console.error(`[PARTIAL LOAD ERROR] ${categorySlug}/${productId}`);
    console.error(err);
    return null;
  }
}

async function fetchReviewPage(page, productId, currentPage) {
  const targetUrl = buildReviewApiUrl(productId, currentPage);

  return await page.evaluate(async (url) => {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest"
      }
    });

    const text = await res.text();

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    return {
      ok: res.ok,
      status: res.status,
      json
    };
  }, targetUrl);
}

async function fetchReviewPageWithRetry(page, productId, currentPage) {
  let lastError = null;

  for (let attempt = 1; attempt <= REVIEW_RETRY_ATTEMPTS; attempt++) {
    try {
      const payload = await fetchReviewPage(page, productId, currentPage);

      if (!payload.ok) {
        throw new Error(`HTTP ${payload.status} at page=${currentPage} attempt=${attempt}`);
      }

      const json = payload.json;
      const list = json?.productFeedBackReviewList;
      if (!Array.isArray(list)) {
        throw new Error(`Invalid payload at page=${currentPage} attempt=${attempt}`);
      }

      return payload;
    } catch (err) {
      lastError = err;
      console.warn(`[retry] productId=${productId} page=${currentPage} attempt=${attempt}/${REVIEW_RETRY_ATTEMPTS}`);

      if (attempt < REVIEW_RETRY_ATTEMPTS) {
        await sleep(REVIEW_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError || new Error(`Failed after retries for productId=${productId} page=${currentPage}`);
}

async function createWorkerPage(context) {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);
  return page;
}

async function recycleWorkerPage(workerId, context, page, reason) {
  try {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  } finally {
    const nextPage = await createWorkerPage(context);
    console.log(`[REVIEW WORKER ${workerId}] page recycled (${reason}).`);
    return nextPage;
  }
}

function savePartialReviewResult(categorySlug, productId, state) {
  const outputPath = getPartialReviewOutputPath(categorySlug, productId);
  const partialResult = {
    categorySlug,
    productId,
    partial: true,
    collectedAt: new Date().toISOString(),
    pagesSeen: Array.from(state.pagesSeen).sort((a, b) => a - b),
    reviewCountUnique: state.byReviewId.size,
    reviews: Array.from(state.byReviewId.values()),
    meta: state.meta,
  };

  fs.writeFileSync(outputPath, JSON.stringify(partialResult, null, 2), "utf8");
  runStats.partialSaved += 1;
  console.log(`[REVIEW PARTIAL SAVED] ${outputPath}`);
}

async function collectReviewsForProduct(page, job) {
  const { categorySlug, productId } = job;
  const activeKey = `${categorySlug}:${productId}`;
  const resumedState = loadPartialReviewState(categorySlug, productId);

  const state = resumedState || {
    byReviewId: new Map(),
    pagesSeen: new Set(),
    meta: {
      sortOrder: REVIEW_SORT_ORDER,
      tag: REVIEW_TAG,
      itemsPerPage: null,
      pageCount: null,
      totalCount: null,
    }
  };

  const startPage = state.pagesSeen.size > 0
    ? Math.max(...Array.from(state.pagesSeen)) + 1
    : 1;

  if (resumedState) {
    runStats.resumedFromPartial += 1;
  }

  activeReviewRuns.set(activeKey, {
    categorySlug,
    productId,
    state,
  });
  writeCurrentStatus({ event: "product_started", categorySlug, productId, startPage });

  console.log(`\n[START REVIEW] category=${categorySlug} productId=${productId} startPage=${startPage}`);

  for (let currentPage = startPage; currentPage <= REVIEW_MAX_PAGES; currentPage++) {
    if (isShuttingDown) {
      console.log(`[review ${categorySlug}/${productId}] interrupt detected, stopping.`);
      break;
    }

    const payload = await fetchReviewPageWithRetry(page, productId, currentPage);

    const json = payload.json;
    const list = json?.productFeedBackReviewList;

    if (json?.pagination?.itemsPerPage != null) state.meta.itemsPerPage = json.pagination.itemsPerPage;
    if (json?.pagination?.pageCount != null) state.meta.pageCount = json.pagination.pageCount;
    if (json?.pagination?.totalCount != null) state.meta.totalCount = json.pagination.totalCount;

    state.pagesSeen.add(currentPage);

    for (const review of list) {
      if (review?.id == null) continue;
      const key = String(review.id);
      if (!state.byReviewId.has(key)) {
        state.byReviewId.set(key, review);
      }
    }

    console.log(`[review ${categorySlug}/${productId}] page=${currentPage} +${list.length} reviews (unique=${state.byReviewId.size})`);
    writeCurrentStatus({ event: "page_completed", categorySlug, productId, currentPage });

    if (currentPage % CHECKPOINT_EVERY_PAGES === 0) {
      savePartialReviewResult(categorySlug, productId, state);
    }

    const lastPage = Boolean(json?.pagination?.lastPage);
    const pageCount = json?.pagination?.pageCount ?? null;

    if (lastPage) break;
    if (pageCount && currentPage >= pageCount) break;
    if (list.length === 0) break;

    await sleep(REVIEW_DELAY_MS + Math.floor(Math.random() * 120));
  }

  activeReviewRuns.delete(activeKey);

  return {
    categorySlug,
    productId,
    collectedAt: new Date().toISOString(),
    resumedFromPartial: Boolean(resumedState),
    pagesSeen: Array.from(state.pagesSeen).sort((a, b) => a - b),
    reviewCountUnique: state.byReviewId.size,
    noReviews: state.byReviewId.size === 0,
    reviews: Array.from(state.byReviewId.values()),
    meta: state.meta,
  };
}

function saveReviewResult(result) {
  const outputPath = getReviewOutputPath(result.categorySlug, result.productId);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");

  const partialPath = getPartialReviewOutputPath(result.categorySlug, result.productId);
  if (fs.existsSync(partialPath)) {
    fs.unlinkSync(partialPath);
  }

  runStats.completed += 1;
  runStats.totalReviewsCollected += result.reviewCountUnique;
  if (result.reviewCountUnique === 0) {
    runStats.zeroReviewProducts += 1;
  }
  writeCurrentStatus({ event: "product_saved", categorySlug: result.categorySlug, productId: result.productId, noReviews: result.reviewCountUnique === 0 });

  console.log(`[REVIEW SAVED] ${outputPath}`);
}

function saveAllActiveReviewPartials() {
  for (const [, activeRun] of activeReviewRuns.entries()) {
    const { categorySlug, productId, state } = activeRun;
    try {
      savePartialReviewResult(categorySlug, productId, state);
    } catch (err) {
      console.error(`[REVIEW PARTIAL SAVE ERROR] ${categorySlug}/${productId}`);
      console.error(err);
    }
  }
  writeCurrentStatus({ event: "partials_saved" });
}

async function processReview(page, job) {
  const { productId } = job;

  await page.goto(buildReviewPageUrl(productId), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await sleep(1200);

  const result = await collectReviewsForProduct(page, job);
  saveReviewResult(result);
}

async function runWorkers(browser, jobs, concurrency = REVIEW_CONCURRENCY) {
  const queue = [...jobs];
  const context = await browser.newContext();

  async function worker(workerId) {
    runStats.activeWorkers += 1;
    let page = await createWorkerPage(context);
    let tasksOnCurrentPage = 0;
    let consecutiveErrors = 0;

    try {
      while (queue.length > 0) {
        if (isShuttingDown) {
          console.log(`[REVIEW WORKER ${workerId}] shutdown detected, exiting.`);
          writeCurrentStatus({ event: "worker_shutdown", workerId });
          return;
        }

        const job = queue.shift();
        if (!job) break;

        const { categorySlug, productId } = job;

        if (fs.existsSync(getReviewOutputPath(categorySlug, productId))) {
          runStats.skippedExisting += 1;
          console.log(`[REVIEW WORKER ${workerId}] skip existing ${categorySlug}/${productId}`);
          writeCurrentStatus({ event: "skip_existing", categorySlug, productId, workerId });
          continue;
        }

        console.log(`\n[REVIEW WORKER ${workerId}] starting ${categorySlug}/${productId}`);

        try {
          await processReview(page, job);
          tasksOnCurrentPage += 1;
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors += 1;
          console.error(`[REVIEW ERROR] ${categorySlug}/${productId}`);
          console.error(err);
          recordFailedJob(job, err);
          writeCurrentStatus({ event: "job_failed", categorySlug, productId, workerId });

          if (consecutiveErrors >= MAX_CONSECUTIVE_WORKER_ERRORS) {
            page = await recycleWorkerPage(
              workerId,
              context,
              page,
              `consecutive errors=${consecutiveErrors}`
            );
            consecutiveErrors = 0;
            tasksOnCurrentPage = 0;
          }
        }

      }
    } finally {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
      runStats.activeWorkers -= 1;
      writeCurrentStatus({ event: "worker_exited", workerId });
    }
  }

  try {
    const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
    await Promise.all(workers);
  } finally {
    await context.close().catch(() => {});
  }
}

process.on("SIGINT", () => {
  if (isShuttingDown) {
    console.log("\n[INTERRUPT] shutdown already in progress...");
    return;
  }

  isShuttingDown = true;
  console.log("\n[INTERRUPT] Ctrl+C received. Saving partial reviews...");
  saveAllActiveReviewPartials();
  writeFailedJobsFiles();
  writeRunSummary();
  writeCurrentStatus({ event: "sigint" });
});

(async () => {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.team) {
    const selectedCategories = resolveTeamCategories(options.team, options.teamCategoryLimit);

    options.categories = new Set(selectedCategories);

    if (!options.name) {
      options.name = options.team;
    }

    console.log(`[TEAM MODE] team=${options.team}`);
    console.log(`[TEAM MODE] assigned remaining categories count=${selectedCategories.length}`);

    if (selectedCategories.length === 0) {
      console.log(`[TEAM MODE] no remaining categories assigned to ${options.team}.`);
      return;
    }

    console.log(`[TEAM MODE] categories: ${selectedCategories.join(", ")}`);
  }

  if (options.listRuns) {
    listPreviousRuns(false);
    return;
  }

  if (options.listAllRuns) {
    listPreviousRuns(true);
    return;
  }

  let effectiveOptions = options;
  let jobs = [];
  let resumedFromRunId = null;
  let runKind = options.failedOnly ? "failed-only" : "normal";

  if (options.resumeRun) {
    const resumePayload = loadJobsForResumeRun(options);
    effectiveOptions = resumePayload.mergedOptions;
    jobs = resumePayload.jobs;
    resumedFromRunId = resumePayload.summary?.runId || options.resumeRun;
    runKind = resumePayload.summary?.filters?.failedOnly ? "failed-only" : "normal";
    console.log(`[RESUME] summary file: ${resumePayload.summaryPath}`);
    console.log(`[RESUME] continuing from runId=${resumedFromRunId}`);
  }

  const targetRunId = options.resumeRun
  ? resumedFromRunId
  : makeRunId(effectiveOptions.name, runKind);

  configureRunFiles(targetRunId);

  runStats.filters = {
    categories: effectiveOptions.categories ? Array.from(effectiveOptions.categories) : null,
    products: effectiveOptions.products ? Array.from(effectiveOptions.products) : null,
    concurrency: effectiveOptions.concurrency,
    failedOnly: effectiveOptions.failedOnly,
    failedFile: effectiveOptions.failedFile,
    resumeRun: resumedFromRunId,
    name: effectiveOptions.name,
    mode: runKind,
  };

  console.log(`[RUN] id=${activeRunId}`);
  console.log(`[RUN] log file: ${logFilePath}`);
  console.log(`[RUN] summary file: ${summaryFilePath}`);

  const browser = await chromium.launch({ headless: false });

  try {
    if (!options.resumeRun) {
      jobs = loadProductIdJobs(effectiveOptions);
    }

    runStats.totalJobsQueued = jobs.length;
    writeCurrentStatus({ event: "run_started", queued: jobs.length });
    console.log(`[REVIEWS] loaded ${jobs.length} review jobs from ${PRODUCT_IDS_DIR}`);

    if (effectiveOptions.categories) {
      console.log(`[REVIEWS] category filter: ${Array.from(effectiveOptions.categories).join(", ")}`);
    }
    if (effectiveOptions.products) {
      console.log(`[REVIEWS] product filter: ${Array.from(effectiveOptions.products).join(", ")}`);
    }
    if (effectiveOptions.failedOnly) {
      console.log(`[REVIEWS] failed-only mode enabled${effectiveOptions.failedFile ? ` using ${effectiveOptions.failedFile}` : ""}`);
    }
    if (resumedFromRunId) {
      console.log(`[REVIEWS] resume mode enabled from ${resumedFromRunId}`);
    }
    if (effectiveOptions.failedOnly) {
      console.log(`[REVIEWS] run is tracked as failed-only mode under runId=${activeRunId}`);
    }
    console.log(`[REVIEWS] concurrency: ${effectiveOptions.concurrency}`);

    await runWorkers(browser, jobs, effectiveOptions.concurrency);

    console.log("\nAll review jobs finished.");
  } catch (err) {
    console.error("[FATAL] review scraping failed");
    console.error(err);
  } finally {
    runStats.finishedAt = new Date().toISOString();
    writeFailedJobsFiles();
    writeRunSummary();
    writeCurrentStatus({ event: "run_finished" });
    await browser.close();
  }
})();