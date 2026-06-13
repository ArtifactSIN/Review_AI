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
const CHECKPOINT_PATH  = path.join(ROOT, 'logs', 'transform_n11_checkpoint.json');

const CHECKPOINT_EVERY = 50; // save checkpoint every N files

// ── GID counter ───────────────────────────────────────────────────────────────
const GID_TMP_PATH = GID_COUNTER_PATH + '.tmp';

function claimGidBlock(count) {
  let data = {};
  if (fs.existsSync(GID_COUNTER_PATH)) {
    try {
      data = JSON.parse(fs.readFileSync(GID_COUNTER_PATH, 'utf8'));
    } catch {
      console.error(
        `\n[ERROR] gid_counter.json is corrupt. Reset with:\n` +
        `  node -e "require('fs').writeFileSync('logs/gid_counter.json', JSON.stringify({next:1},null,2))"\n` +
        `Then re-run.`
      );
      process.exit(1);
    }
  }
  const start = (data?.next && Number.isFinite(data.next)) ? data.next : 1;
  // Atomic write: temp file → rename prevents corrupt reads mid-write
  fs.writeFileSync(GID_TMP_PATH, JSON.stringify({ next: start + count }, null, 2), 'utf8');
  fs.renameSync(GID_TMP_PATH, GID_COUNTER_PATH);
  return start;
}

// ── Date parsing ──────────────────────────────────────────────────────────────
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
function normaliseRating(scoreAsStar) {
  if (typeof scoreAsStar !== 'number' || !Number.isFinite(scoreAsStar)) return null;
  if (scoreAsStar < 0 || scoreAsStar > 5) return null;
  return Math.round(scoreAsStar * 20);
}

// ── Unified schema transform ──────────────────────────────────────────────────
function transformReview(raw, productId, categorySlug, gid) {
  const unified = {
    gid,
    rid:              String(raw.id ?? ''),
    pid:              String(productId),
    seller:           raw.sellerNickname             ?? null,
    product_name:     null,
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
    modifiedDate:     null,
    label:            null,
    label_confidence: null,
    is_elite:         null,
    is_influencer:    null,
    is_verified:      null,
    trusted:          null,
  };

  const excludedData = {};
  const EXCLUDED_KEYS = ['title', 'productTitle', 'language', 'culture'];

  for (const key of EXCLUDED_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') {
      excludedData[key] = raw[key];
    }
  }

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
    ? { gid_ref: gid, reason: 'excluded_fields', platform: 'n11', data: excludedData }
    : null;

  return { unified, excluded };
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

function writeExcluded(categorySlug, productId, excludedRecords) {
  if (excludedRecords.length === 0) return;
  const dir = path.join(EXCLUDED_DIR, sanitizeSlug(categorySlug));
  ensureDir(dir);
  const filePath = path.join(dir, `${sanitizeSlug(productId)}_excluded.json`);
  fs.writeFileSync(filePath, JSON.stringify(excludedRecords, null, 2), 'utf8');
}

// ── Checkpoint ────────────────────────────────────────────────────────────────
function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveCheckpoint(done, totalFiles, totalReviews, startedAt) {
  const cp = {
    version:      1,
    startedAt,
    savedAt:      new Date().toISOString(),
    processedFiles: Array.from(done),
    totalFiles,
    totalReviews,
  };
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2), 'utf8');
}

// ── Progress display ──────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatNum(n) {
  return n.toLocaleString('en-US');
}

function renderProgress(done, total, reviews, startMs) {
  const pct      = total > 0 ? done / total : 0;
  const barWidth = 30;
  const filled   = Math.round(pct * barWidth);
  const bar      = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const pctStr   = (pct * 100).toFixed(1).padStart(5);

  const elapsed  = Date.now() - startMs;
  const rate     = done > 0 ? elapsed / done : 0;          // ms per file
  const remaining = rate > 0 ? (total - done) * rate : NaN;
  const eta      = formatDuration(remaining);

  const line = `[${bar}] ${pctStr}% | ${formatNum(done)}/${formatNum(total)} files | ${formatNum(reviews)} reviews | ETA ${eta}`;

  // Truncate to terminal width to avoid wrapping
  const cols = process.stdout.columns || 100;
  process.stdout.write('\r' + line.slice(0, cols));
}

// ── File processor ────────────────────────────────────────────────────────────
// Uses appendFileSync per product so data lands on disk immediately,
// avoiding stream-buffer loss on WSL→Windows FS paths.
function processFile(filePath, categorySlug) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    process.stderr.write(`\n  [SKIP] JSON parse error: ${filePath} — ${err.message}\n`);
    return 0;
  }

  const reviews = data.reviews;
  if (!Array.isArray(reviews) || reviews.length === 0) return 0;

  const productId = String(
    data.productId ?? path.basename(filePath).replace('_reviews.json', '')
  );

  const gidStart      = claimGidBlock(reviews.length);
  const excludedBatch = [];
  const lines         = [];

  for (let i = 0; i < reviews.length; i++) {
    const { unified, excluded } = transformReview(
      reviews[i],
      productId,
      categorySlug,
      gidStart + i
    );
    lines.push(JSON.stringify(unified));
    if (excluded) excludedBatch.push(excluded);
  }

  // Batch write: one syscall per product, flushed to OS immediately
  fs.appendFileSync(OUTPUT_FILE, lines.join('\n') + '\n', 'utf8');

  writeExcluded(categorySlug, productId, excludedBatch);
  return reviews.length;
}

// ── Discover all files ────────────────────────────────────────────────────────
function discoverFiles() {
  const result = [];
  const categories = fs.readdirSync(N11_RAW_DIR)
    .filter(f => fs.statSync(path.join(N11_RAW_DIR, f)).isDirectory())
    .sort();

  for (const cat of categories) {
    const catDir = path.join(N11_RAW_DIR, cat);
    const files  = fs.readdirSync(catDir)
      .filter(f => f.endsWith('_reviews.json') && !f.endsWith('.partial.json'))
      .sort();
    for (const f of files) {
      result.push({ filePath: path.join(catDir, f), categorySlug: cat });
    }
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(N11_RAW_DIR)) {
    console.error(`[ERROR] n11/raw_data not found: ${N11_RAW_DIR}`);
    process.exit(1);
  }

  ensureDir(OUTPUT_DIR);
  ensureDir(path.join(ROOT, 'logs'));

  // ── Load checkpoint ──
  const checkpoint  = loadCheckpoint();
  const isResume    = !!checkpoint;
  const doneSet     = new Set(isResume ? checkpoint.processedFiles : []);
  const startedAt   = isResume ? checkpoint.startedAt : new Date().toISOString();

  if (isResume) {
    console.log(`[RESUME] checkpoint: ${checkpoint.processedFiles.length} files already done`);
    console.log(`         started: ${checkpoint.startedAt}`);
  } else {
    console.log('[START] fresh run');
    // Wipe output file on fresh start
    if (fs.existsSync(OUTPUT_FILE)) {
      fs.unlinkSync(OUTPUT_FILE);
      console.log('        existing output cleared');
    }
    if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
  }

  // ── Discover all files ──
  console.log('Scanning raw_data...');
  const allFiles = discoverFiles();
  const total    = allFiles.length;

  const pending  = allFiles.filter(({ filePath }) => !doneSet.has(filePath));

  console.log(`Files: ${formatNum(total)} total | ${formatNum(doneSet.size)} done | ${formatNum(pending.length)} pending`);
  console.log('');

  if (pending.length === 0) {
    console.log('[DONE] nothing left to process');
    if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
    return;
  }

  let totalReviews   = isResume ? (checkpoint.totalReviews ?? 0) : 0;
  let filesProcessed = 0;
  let stopping       = false;
  const startMs      = Date.now();

  // ── Graceful stop (Ctrl+C or SIGTERM) ──
  // appendFileSync already flushed each product to disk, so no stream to drain.
  function handleStop(signal) {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\n');
    const label = signal === 'SIGTERM' ? 'SIGTERM received' : 'Ctrl+C received';
    console.log(`\n[STOP] ${label} — saving checkpoint...`);
    saveCheckpoint(doneSet, total, totalReviews, startedAt);
    console.log(`[CHECKPOINT] saved → ${CHECKPOINT_PATH}`);
    console.log(`             ${formatNum(doneSet.size)}/${formatNum(total)} files done, ${formatNum(totalReviews)} reviews written`);
    console.log('Resume: node pipeline/transform_n11_run.js');
    process.exit(0);
  }

  process.on('SIGINT',  () => handleStop('SIGINT'));
  process.on('SIGTERM', () => handleStop('SIGTERM'));

  // ── Process files ──
  for (const { filePath, categorySlug } of pending) {
    if (stopping) break;

    const count = processFile(filePath, categorySlug);
    doneSet.add(filePath);
    filesProcessed++;
    totalReviews += count;

    renderProgress(doneSet.size, total, totalReviews, startMs);

    if (filesProcessed % CHECKPOINT_EVERY === 0) {
      saveCheckpoint(doneSet, total, totalReviews, startedAt);
    }
  }

  if (!stopping) {
    process.stdout.write('\n\n');
    if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log('─────────────────────────────────────────────');
    console.log(`Files processed : ${formatNum(filesProcessed)}`);
    console.log(`Total reviews   : ${formatNum(totalReviews)}`);
    console.log(`Time elapsed    : ${elapsed}s`);
    console.log(`Output (JSONL)  : ${OUTPUT_FILE}`);
    console.log(`Excluded dir    : ${EXCLUDED_DIR}`);
    console.log('─────────────────────────────────────────────');
  }
}

main();
