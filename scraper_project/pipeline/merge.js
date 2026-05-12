'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const OUTPUT_DIR   = path.join(__dirname, '..', 'output');
const SOURCES      = ['n11_reviews.jsonl', 'trendyol_reviews.jsonl'];
const MERGED_FILE  = path.join(OUTPUT_DIR, 'all_reviews.jsonl');

async function appendFile(srcPath, writeStream) {
  return new Promise((resolve, reject) => {
    const rl  = readline.createInterface({ input: fs.createReadStream(srcPath), crlfDelay: Infinity });
    let count = 0;

    rl.on('line', line => {
      const trimmed = line.trim();
      if (trimmed) {
        writeStream.write(trimmed + '\n');
        count++;
      }
    });

    rl.on('close', () => resolve(count));
    rl.on('error', reject);
  });
}

async function main() {
  const available = SOURCES
    .map(f => ({ name: f, filePath: path.join(OUTPUT_DIR, f) }))
    .filter(({ filePath }) => fs.existsSync(filePath));

  if (available.length === 0) {
    console.error('Birleştirilecek JSONL dosyası yok. Önce transform scriptlerini çalıştırın:');
    console.error('  node pipeline/transform_n11.js');
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const writeStream = fs.createWriteStream(MERGED_FILE);
  let total = 0;

  for (const { name, filePath } of available) {
    const count = await appendFile(filePath, writeStream);
    console.log(`  ${name}: ${count.toLocaleString()} yorum eklendi`);
    total += count;
  }

  await new Promise(resolve => writeStream.end(resolve));

  console.log('\n─────────────────────────────────────────────');
  console.log(`Toplam yorumlar: ${total.toLocaleString()}`);
  console.log(`Çıktı          : ${MERGED_FILE}`);

  const missing = SOURCES.filter(f => !fs.existsSync(path.join(OUTPUT_DIR, f)));
  if (missing.length > 0) {
    console.log(`\nNot: Henüz hazır olmayan platform(lar): ${missing.join(', ')}`);
    console.log('Merge tamamlandığında bu scripti tekrar çalıştırın.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
