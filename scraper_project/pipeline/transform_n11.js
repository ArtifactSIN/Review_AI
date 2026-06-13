'use strict';

const fs   = require('fs');
const path = require('path');

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT             = path.join(__dirname, '..');
const N11_RAW_DIR      = path.join(ROOT, 'n11', 'raw_data');
const OUTPUT_DIR       = path.join(ROOT, 'output');
const OUTPUT_FILE      = path.join(OUTPUT_DIR, 'n11_reviews.jsonl');
const EXCLUDED_DIR     = path.join(ROOT, 'n11', 'excluded_data');
const GID_COUNTER_PATH = path.join(ROOT, 'logs', 'gid_counter.json');

// ── GID counter ───────────────────────────────────────────────────────────────
// Synchronous read→write: safe in single-threaded Node.js.
// IMPORTANT: Run n11 transform fully before starting Trendyol — shared counter.
function claimGidBlock(count) {
  let data = {};
  if (fs.existsSync(GID_COUNTER_PATH)) {
    data = JSON.parse(fs.readFileSync(GID_COUNTER_PATH, 'utf8'));
  }
  const start = (data?.next && Number.isFinite(data.next)) ? data.next : 1;
  fs.writeFileSync(
    GID_COUNTER_PATH,
    JSON.stringify({ next: start + count }, null, 2),
    'utf8'
  );
  return start;
}

// ── Date parsing ──────────────────────────────────────────────────────────────
// n11 stores dates as "DD/MM/YYYY". Returns ISO 8601 UTC string or null.
function parseN11Date(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  const d = new Date(
    `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00.000Z`
  );
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Rating normalisation ──────────────────────────────────────────────────────
// n11 uses 1–5 star scale (scoreAsStar). Unified schema uses 0–100.
// 1 star = 20, 5 stars = 100. Null/invalid input → null.
function normaliseRating(scoreAsStar) {
  if (typeof scoreAsStar !== 'number' || !Number.isFinite(scoreAsStar)) return null;
  if (scoreAsStar < 0 || scoreAsStar > 5) return null;
  return Math.round(scoreAsStar * 20);
}

// ── Unified schema transform ──────────────────────────────────────────────────
// Returns { unified, excluded } pair.
//
// Unified schema fields (all platforms):
//   gid, rid, pid, seller, product_name, comment, rating_score,
//   timestamp, customer_name, helpful_votes, useless_votes,
//   image_count, resolved, category, platform, modifiedDate,
//   label, label_confidence, is_elite, is_influencer, is_verified, trusted
//
// Excluded fields (n11-specific, kept alongside for reference):
//   title, productTitle, language, culture, + any unknown keys
function transformReview(raw, productId, categorySlug, gid) {
  // ── Core unified record ──
  const unified = {
    gid,
    rid:              String(raw.id ?? ''),
    pid:              String(productId),
    seller:           raw.sellerNickname             ?? null,
    product_name:     null,                              // not available from n11 at scrape time
    comment:          raw.contents                   ?? null,
    rating_score:     normaliseRating(raw.scoreAsStar),
    timestamp:        parseN11Date(raw.createdDate),
    customer_name:    raw.maskedBuyerName             ?? null,
    helpful_votes:    raw.helpfulVoteCount            ?? 0,
    useless_votes:    raw.uselessVoteCount            ?? null,
    image_count:      Array.isArray(raw.imageFilePathList)
                        ? raw.imageFilePathList.length
                        : 0,
    resolved:         raw.resolved                   ?? null,
    category:         categorySlug,
    platform:         'n11',
    modifiedDate:     null,                              // n11 does not expose this
    label:            null,                              // filled by ML pipeline
    label_confidence: null,                              // filled by ML pipeline
    is_elite:         null,                              // n11 does not expose this
    is_influencer:    null,                              // n11 does not expose this
    is_verified:      null,                              // n11 does not expose this
    trusted:          null,                              // n11 does not expose this
  };

  // ── Excluded fields ──
  // Kept for potential future use; never merged into unified schema.
  const excludedData = {};
  const EXCLUDED_KEYS = ['title', 'productTitle', 'language', 'culture'];

  for (const key of EXCLUDED_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') {
      excludedData[key] = raw[key];
    }
  }

  // Capture any unknown keys not in unified or excluded lists
  const KNOWN_KEYS = new Set([
    'id', 'sellerNickname', 'contents', 'scoreAsStar', 'createdDate',
    'maskedBuyerName', 'helpfulVoteCount', 'uselessVoteCount',
    'imageFilePathList', 'resolved',
    ...EXCLUDED_KEYS,
  ]);

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key) && raw[key] !== undefined && raw[key] !== null) {
      excludedData[`__unknown_${key}`] = raw[key];
    }
  }

  const excluded = Object.keys(excludedData).length > 0
    ? {
        gid_ref:  gid,
        reason:   'excluded_fields',
        platform: 'n11',
        data:     excludedData,
      }
    : null;

  return { unified, excluded };
}

// ── Excluded data writer ──────────────────────────────────────────────────────
function writeExcluded(categorySlug, productId, excludedRecords) {
  if (excludedRecords.length === 0) return;

  const dir = path.join(EXCLUDED_DIR, sanitizeSlug(categorySlug));
  ensureDir(dir);
  const filePath = path.join(dir, `${sanitizeSlug(productId)}_excluded.json`);
  fs.writeFileSync(filePath, JSON.stringify(excludedRecords, null, 2), 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitizeSlug(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ── File processor ────────────────────────────────────────────────────────────
function processFile(filePath, categorySlug, writeStream) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`  [SKIP] JSON parse error: ${filePath} — ${err.message}`);
    return 0;
  }

  const reviews = data.reviews;
  if (!Array.isArray(reviews) || reviews.length === 0) return 0;

  const productId = String(
    data.productId ?? path.basename(filePath).replace('_reviews.json', '')
  );

  const gidStart      = claimGidBlock(reviews.length);
  const excludedBatch = [];

  for (let i = 0; i < reviews.length; i++) {
    const { unified, excluded } = transformReview(
      reviews[i],
      productId,
      categorySlug,
      gidStart + i
    );
    writeStream.write(JSON.stringify(unified) + '\n');
    if (excluded) excludedBatch.push(excluded);
  }

  writeExcluded(categorySlug, productId, excludedBatch);

  return reviews.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(N11_RAW_DIR)) {
    console.error(`[ERROR] n11/raw_data not found: ${N11_RAW_DIR}`);
    console.error('Run scraping first: npm run scrape_review_def');
    process.exit(1);
  }

  ensureDir(OUTPUT_DIR);
  ensureDir(path.join(ROOT, 'logs'));

  const writeStream = fs.createWriteStream(OUTPUT_FILE, { encoding: 'utf8' });

  const categories = fs.readdirSync(N11_RAW_DIR)
    .filter(f => fs.statSync(path.join(N11_RAW_DIR, f)).isDirectory())
    .sort();

  let totalReviews    = 0;
  let totalProducts   = 0;
  let totalCategories = 0;
  let totalSkipped    = 0;

  for (const categorySlug of categories) {
    const catDir = path.join(N11_RAW_DIR, categorySlug);
    const files  = fs.readdirSync(catDir)
      .filter(f => f.endsWith('_reviews.json') && !f.endsWith('.partial.json'));

    if (files.length === 0) continue;

    let catReviews = 0;
    let catSkipped = 0;

    for (const file of files) {
      const count = processFile(path.join(catDir, file), categorySlug, writeStream);
      if (count === 0) {
        catSkipped++;
      } else {
        catReviews   += count;
        totalProducts++;
      }
    }

    totalReviews    += catReviews;
    totalSkipped    += catSkipped;
    totalCategories++;

    console.log(
      `  [${categorySlug}] ${files.length - catSkipped} ürün, ${catReviews} yorum` +
      (catSkipped ? ` (${catSkipped} sıfır-yorum atlandı)` : '')
    );
  }

  writeStream.end(() => {
    console.log('\n─────────────────────────────────────────────');
    console.log(`Kategoriler   : ${totalCategories}`);
    console.log(`Ürünler       : ${totalProducts}`);
    console.log(`Yorumlar      : ${totalReviews}`);
    console.log(`Sıfır-yorum   : ${totalSkipped}`);
    console.log(`Çıktı (JSONL) : ${OUTPUT_FILE}`);
    console.log(`Excluded dir  : ${EXCLUDED_DIR}`);
  });
}

main();
