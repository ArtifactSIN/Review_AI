const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const INPUT_FILE = path.join(__dirname, "categories.txt");
const OUTPUT_DIR = path.join(__dirname, "product_ids");

const TARGET_UNIQUE_IDS = 1000;
const START_PAGE = 2;
const DELAY_MS = 250;
const MAX_REPEAT_PAGES = 3;
const MAX_PAGES_PER_CATEGORY = 200;
const CONCURRENCY = 3;

const MAX_TASKS_PER_PAGE = 10;
const MAX_CONSECUTIVE_WORKER_ERRORS = 3;

let isShuttingDown = false;
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

  return fs
    .readFileSync(INPUT_FILE, "utf8")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildTemplateUrl(categoryUrl, page = START_PAGE) {
  const url = new URL(categoryUrl);

  // remove old pg if present, then set correctly
  url.searchParams.set("pg", String(page));
  url.searchParams.set("vueSearch", "1");

  return url.toString();
}

function slugFromCategoryUrl(categoryUrl) {
  const url = new URL(categoryUrl);
  const cleaned = url.pathname.replace(/^\/+|\/+$/g, "");
  return cleaned || "category";
}

async function fetchListingPage(page, url) {
  return await page.evaluate(async (targetUrl) => {
    const res = await fetch(targetUrl, {
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    const text = await res.text();

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    return {
      ok: res.ok,
      status: res.status,
      text,
      json,
    };
  }, url);
}

function extractListingIds(payload) {
  const ids = payload?.json?.data?.listingProductIds;
  if (Array.isArray(ids)) {
    return ids.map((x) => String(x)).filter(Boolean);
  }

  // fallback
  const items = payload?.json?.data?.adbiddingProductListingItems;
  if (Array.isArray(items)) {
    return items
      .map((item) => item?.id ?? item?.productId ?? null)
      .filter(Boolean)
      .map(String);
  }

  return [];
}

function buildPartialResult(categoryUrl, uniqueIds) {
  const slug = slugFromCategoryUrl(categoryUrl);
  return {
    categoryUrl,
    slug,
    collectedAt: new Date().toISOString(),
    targetUniqueIds: TARGET_UNIQUE_IDS,
    uniqueCount: uniqueIds.size,
    ids: Array.from(uniqueIds),
    partial: true,
  };
}

async function collectIdsForCategory(page, categoryUrl) {
  const slug = slugFromCategoryUrl(categoryUrl);
  const uniqueIds = new Set();

  let repeatCount = 0;
  let previousSignature = null;

  activeCategoryRuns.set(categoryUrl, uniqueIds);

  console.log(`\n[START] ${slug}`);
  console.log(`Category URL: ${categoryUrl}`);

  for (let pg = START_PAGE; pg <= MAX_PAGES_PER_CATEGORY; pg++) {
    if (isShuttingDown) {
      console.log(`[${slug}] interrupt detected, stopping category loop.`);
      break;
    }

    const targetUrl = buildTemplateUrl(categoryUrl, pg);

    const payload = await fetchListingPage(page, targetUrl);

    if (!payload.ok) {
      console.log(`[${slug}] HTTP ${payload.status} at pg=${pg}, stopping.`);
      break;
    }

    const ids = extractListingIds(payload);

    if (!ids.length) {
      console.log(`[${slug}] No IDs at pg=${pg}, stopping.`);
      break;
    }

    const signature = ids.join(",");

    if (signature === previousSignature) {
      repeatCount += 1;
      console.log(
        `[${slug}] repeated content at pg=${pg} (${repeatCount}/${MAX_REPEAT_PAGES})`,
      );

      if (repeatCount >= MAX_REPEAT_PAGES) {
        console.log(`[${slug}] repeat threshold reached, stopping.`);
        break;
      }
    } else {
      repeatCount = 0;
    }

    previousSignature = signature;

    let addedThisPage = 0;
    for (const id of ids) {
      if (!uniqueIds.has(id)) {
        uniqueIds.add(id);
        addedThisPage += 1;
      }
    }

    console.log(
      `[${slug}] pg=${pg} +${addedThisPage} new, unique total=${uniqueIds.size}`,
    );

    if (uniqueIds.size >= TARGET_UNIQUE_IDS) {
      console.log(`[${slug}] reached target ${TARGET_UNIQUE_IDS}, stopping.`);
      break;
    }

    await sleep(DELAY_MS + Math.floor(Math.random() * 120));
  }

  activeCategoryRuns.delete(categoryUrl);

  return {
    categoryUrl,
    slug,
    collectedAt: new Date().toISOString(),
    targetUniqueIds: TARGET_UNIQUE_IDS,
    uniqueCount: uniqueIds.size,
    ids: Array.from(uniqueIds),
  };
}

function saveCategoryResult(result) {
  const fileName = `${result.slug}_ids.json`;
  const outputPath = path.join(OUTPUT_DIR, fileName);

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`[SAVED] ${outputPath}`);
}

function savePartialCategoryResult(categoryUrl, uniqueIds) {
  const result = buildPartialResult(categoryUrl, uniqueIds);
  const fileName = `${result.slug}_ids.partial.json`;
  const outputPath = path.join(OUTPUT_DIR, fileName);

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`[PARTIAL SAVED] ${outputPath}`);
}

function saveAllActivePartials() {
  for (const [categoryUrl, uniqueIds] of activeCategoryRuns.entries()) {
    try {
      savePartialCategoryResult(categoryUrl, uniqueIds);
    } catch (err) {
      console.error(`[PARTIAL SAVE ERROR] ${categoryUrl}`);
      console.error(err);
    }
  }
}

async function createWorkerPage(context) {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);
  return page;
}

async function processCategory(page, categoryUrl) {
  await page.goto("https://www.n11.com", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(1500);

  const result = await collectIdsForCategory(page, categoryUrl);
  saveCategoryResult(result);
}

async function runWithConcurrency(
  context,
  categoryUrls,
  concurrency = CONCURRENCY,
) {
  const queue = [...categoryUrls];

  async function recycleWorkerPage(workerId, page, reason) {
    try {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
    } finally {
      const nextPage = await createWorkerPage(context);
      console.log(`[WORKER ${workerId}] page recycled (${reason}).`);
      return nextPage;
    }
  }

  async function worker(workerId) {
    let page = await createWorkerPage(context);
    let tasksOnCurrentPage = 0;
    let consecutiveErrors = 0;

    try {
      while (queue.length > 0) {
        if (isShuttingDown) {
          console.log(`[WORKER ${workerId}] shutdown detected, exiting.`);
          return;
        }

        const categoryUrl = queue.shift();
        if (!categoryUrl) return;

        console.log(`\n[WORKER ${workerId}] starting ${categoryUrl}`);

        try {
          await processCategory(page, categoryUrl);
          tasksOnCurrentPage += 1;
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors += 1;
          console.error(`[ERROR] ${categoryUrl}`);
          console.error(err);

          if (consecutiveErrors >= MAX_CONSECUTIVE_WORKER_ERRORS) {
            page = await recycleWorkerPage(
              workerId,
              page,
              `consecutive errors=${consecutiveErrors}`,
            );
            consecutiveErrors = 0;
            tasksOnCurrentPage = 0;
          }
        }

        if (tasksOnCurrentPage >= MAX_TASKS_PER_PAGE) {
          page = await recycleWorkerPage(
            workerId,
            page,
            `task limit reached (${tasksOnCurrentPage})`,
          );
          tasksOnCurrentPage = 0;
        }
      }
    } finally {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);
}

process.on("SIGINT", () => {
  if (isShuttingDown) {
    console.log("\n[INTERRUPT] shutdown already in progress...");
    return;
  }

  isShuttingDown = true;
  console.log("\n[INTERRUPT] Ctrl+C received. Saving partial results...");
  saveAllActivePartials();
});

(async () => {
  const categoryUrls = readCategoryUrls();

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, ".pw-user"),
    {
      headless: false,
      args: [
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
      ],
      viewport: { width: 1200, height: 800 },
    },
  );

  try {
    await runWithConcurrency(context, categoryUrls, CONCURRENCY);
  } catch (err) {
    console.error("[FATAL] category scraping failed");
    console.error(err);
  } finally {
    await context.close();
  }

  console.log("\nAll categories finished.");
})();
