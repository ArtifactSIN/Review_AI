'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT             = path.join(__dirname, '..');
const N11_RAW_DIR      = path.join(ROOT, 'n11', 'raw_data');
const OUTPUT_DIR       = path.join(ROOT, 'output');
const OUTPUT_FILE      = path.join(OUTPUT_DIR, 'n11_reviews.jsonl');
const GID_COUNTER_PATH = path.join(ROOT, 'logs', 'gid_counter.json');

// ── GID counter ───────────────────────────────────────────────────────────────
// Synchronous: no await between read and write — safe in single-threaded Node.js.
function claimGidBlock(count) {
  let data = {};
  if (fs.existsSync(GID_COUNTER_PATH)) {
    data = JSON.parse(fs.readFileSync(GID_COUNTER_PATH, 'utf8'));
  }
  const start = (data?.next && Number.isFinite(data.next)) ? data.next : 1;
  fs.writeFileSync(GID_COUNTER_PATH, JSON.stringify({ next: start + count }, null, 2), 'utf8');
  return start;
}

// ── Date parsing ──────────────────────────────────────────────────────────────
// n11 stores dates as "DD/MM/YYYY" strings. Convert to ISO 8601 UTC midnight.
function parseN11Date(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  const d = new Date(`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Review transformation ─────────────────────────────────────────────────────
function transformReview(raw, productId, categorySlug, gid) {
  return {
    gid,
    rid:              String(raw.id ?? ''),
    pid:              String(productId),
    seller:           raw.sellerNickname    ?? null,
    product_name:     null,
    comment:          raw.contents          ?? null,
    rating_score:     typeof raw.scoreAsStar === 'number' ? raw.scoreAsStar * 20 : null,
    timestamp:        parseN11Date(raw.createdDate),
    customer_name:    raw.maskedBuyerName   ?? null,
    helpful_votes:    raw.helpfulVoteCount  ?? 0,
    useless_votes:    raw.uselessVoteCount  ?? null,
    image_count:      Array.isArray(raw.imageFilePathList) ? raw.imageFilePathList.length : 0,
    resolved:         raw.resolved          ?? null,
    category:         categorySlug,
    platform:         'n11',
    modifiedDate:     null,
    label:            null,
    label_confidence: null,
    is_elite:         null,
    is_influencer:    null,
    is_verified:      null,
    trusted:          null,
  };
}

// ── File processor ────────────────────────────────────────────────────────────
function processFile(filePath, categorySlug, writeStream) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const reviews = data.reviews;

  if (!Array.isArray(reviews) || reviews.length === 0) return 0;

  const productId = String(data.productId ?? path.basename(filePath).replace('_reviews.json', ''));
  const gidStart  = claimGidBlock(reviews.length);

  for (let i = 0; i < reviews.length; i++) {
    const unified = transformReview(reviews[i], productId, categorySlug, gidStart + i);
    writeStream.write(JSON.stringify(unified) + '\n');
  }

  return reviews.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(N11_RAW_DIR)) {
    console.error(`Hata: n11/raw_data bulunamadı: ${N11_RAW_DIR}`);
    console.error('Önce n11 scraping tamamlanmalı (npm run scrape_review_def).');
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const writeStream = fs.createWriteStream(OUTPUT_FILE);

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
        catReviews += count;
        totalProducts++;
      }
    }

    totalReviews    += catReviews;
    totalSkipped    += catSkipped;
    totalCategories++;
    console.log(`  [${categorySlug}] ${files.length - catSkipped} ürün, ${catReviews} yorum${catSkipped ? ` (${catSkipped} sıfır-yorum)` : ''}`);
  }

  writeStream.end(() => {
    console.log('\n─────────────────────────────────────────────');
    console.log(`Kategoriler : ${totalCategories}`);
    console.log(`Ürünler     : ${totalProducts}`);
    console.log(`Yorumlar    : ${totalReviews}`);
    console.log(`Sıfır-yorum : ${totalSkipped}`);
    console.log(`Çıktı       : ${OUTPUT_FILE}`);
  });
}

main();
