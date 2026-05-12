# Proje Notları — Scraper & Pipeline

Unutulmaması gereken kararlar, yarım kalan işler ve sıradaki adımlar.

---

## Mevcut Durum (Mayıs 2026)

### N11

| Durum | Detay |
|---|---|
| Phase 1 (product ID toplama) | ✅ Tamamlandı — 67 kategori, `n11/product_ids/` dolu |
| Phase 2 (yorum çekme) | 🔄 Kısmen yapıldı — `havvagul` run'ında 593 ürün, 4258 yorum toplandı. `raw_data/` klasörü henüz oluşturulmadı/kayıp. |
| Pipeline (transform + JSONL) | ⏳ Bekliyor — raw_data dolunca `npm run transform_n11` |

**n11 aktif kategoriler** (`n11/categories.txt` — 13 kategori şu an):
ev-tekstili, mobilya, video-oyun-konsol, fotograf-ve-kamera, beyaz-esya,
elektrikli-ev-aletleri, televizyon-ve-ses-sistemleri, bilgisayar,
telefon-ve-aksesuarlari, cocuk-giyim-aksesuar, erkek-giyim-aksesuar,
kadin-giyim-aksesuar, ayakkabi-ve-canta

Tam kategori listesi CLAUDE.md'de takım atamaları altında.

### Trendyol

| Durum | Detay |
|---|---|
| Phase 1 (product ID toplama) | ✅ Tamamlandı — 809 kategori, `trendyol/product_ids/` dolu |
| Phase 2 (yorum çekme) | ❌ Henüz başlanmadı |
| Pipeline | ❌ Bekliyor |

---

## Sıradaki Adımlar (Öncelik Sırasına Göre)

### 1. N11 Scraping'i Tamamla

```bash
# Takım bazlı çalıştır (her birini farklı terminalde):
npm run scrape_arda
npm run scrape_tugce
npm run scrape_havvagul

# Failedlar varsa:
npm run failed_scrapes
```

`n11/raw_data/` oluştuğunda pipeline hazır.

### 2. N11 → JSONL Dönüşümü

```bash
npm run transform_n11
# Çıktı: output/n11_reviews.jsonl
```

### 3. Trendyol Scraping'i Başlat

```bash
npm run scrape_ty_arda
npm run scrape_ty_tugce
npm run scrape_ty_havvagul
```

Trendyol scraping bitmeden `merge_reviews` çalıştırma.

### 4. Birleştir ve Parquet Üret

```bash
npm run merge_reviews   # output/all_reviews.jsonl
npm run to_parquet      # output/parquet_by_platform/ + parquet_by_platform_year/
```

### 5. Derived Data (Bu sırayla)

```
1. duplicate_pairs.jsonl   — comment text SHA256 hash ile copy-paste tespiti
2. author_profiles.jsonl   — masked customer bazında davranış profili
3. seller_profiles.jsonl   — satıcı bazında rating istatistikleri
4. product_timeseries.jsonl — günlük yorum sayısı ve rating trendi
5. category_anomaly.jsonl  — kategori bazında rating dağılımı (KL divergence)
6. cross_platform_products.jsonl — Trendyol gelince (n11 ↔ Trendyol ürün eşleştirme)
```

Derived script'leri henüz yazılmadı. Önce `all_reviews.jsonl` hazır olmalı.

---

## Kritik Kararlar (Değiştirme)

### Unified Schema

Şu an kesinleşmiş alan listesi:
```
gid, rid, pid, seller, product_name (null), comment, rating_score (0–100),
timestamp (ISO 8601), customer_name, helpful_votes, useless_votes,
image_count, resolved, category, platform, modifiedDate,
label (null), label_confidence (null),
is_elite, is_influencer, is_verified, trusted
```

- `product_name` — şu an her iki platformda **null**. Trendyol scrape scriptine eklenmesi planlanıyor (product metadata API veya URL parse).
- `review_title` (n11'deki `title`) — unified schema'ya **eklenmedi**, ham veride kalıyor.
- `productTitle` (n11 raw) — unified schema'ya **eklenmedi**.
- Deduplication — **yapılmıyor**. Ham verinin tamamı saklanıyor.

### GID Counter

Tek global sayaç: `logs/gid_counter.json` → `{"next": N}`

Hem `pipeline/transform_n11.js` hem `trendyol/collection_auto_rawData.js` bu dosyayı kullanıyor. Trendyol scrape başlamadan önce n11 transform tamamlanmış olmalı — yoksa GID çakışması olur.

**Güvenli sıra:** n11 transform → Trendyol scrape → merge

### Parquet Yapısı

İki şema aynı anda tutulur (her ikisi de `output/all_reviews.jsonl` kaynağından üretilir):
- `output/parquet_by_platform/` — platform bazlı analiz
- `output/parquet_by_platform_year/` — zaman serisi analiz

Parquet türetilmiş çıktıdır. Kaynak JSONL değişince `npm run to_parquet` ile yeniden üretilir.

### Ham Veri

`n11/raw_data/` ve `trendyol/raw_data/` **asla silinmez**. `output/` sadece transform edilmiş veriyi içerir.

---

## ML Feature Generation (Derived Veriler Nasıl Kullanılır)

Derived dosyalar farklı granularitede (satıcı başına, yazar başına) — doğrudan reviews ile merge edilmez. Feature engineering sırasında DuckDB ile join yapılır:

```sql
SELECT
  r.*,
  sp.avg_rating        AS seller_avg_rating,
  sp.review_velocity   AS seller_velocity,
  ap.distinct_sellers  AS author_seller_count,
  CASE WHEN dp.gid_a IS NOT NULL THEN true ELSE false END AS text_duplicate
FROM reviews r
LEFT JOIN seller_profiles sp  ON r.seller = sp.seller AND r.platform = sp.platform
LEFT JOIN author_profiles ap  ON r.customer_name = ap.customer_name AND r.platform = ap.platform
LEFT JOIN duplicate_pairs dp  ON r.gid = dp.gid_a OR r.gid = dp.gid_b
```

Çıktı: `ml_features.parquet` → model bununla beslenir.

---

## Trendyol — `product_name` Çekimi (Yapılacak)

`trendyol/collection_auto_rawData.js` içinde `transformReview()` fonksiyonuna `product_name` eklenmesi gerekiyor. Seçenekler:

1. **URL slug'ından parse** — `trendyol/product_ids/` dosyalarındaki URL'den (güvenilmez, kaba)
2. **Product metadata API** — Scrape sırasında ayrı bir istek (ek yük)
3. **Null bırak** — Tutarlılık açısından en basit

Karar verilmedi. Trendyol scraping başlamadan önce netleştirilmeli.

---

## Dosya Yapısı (Tam)

```
scraper_project/
├── n11/
│   ├── raw_data/                    # Ham — dokunulmaz (henüz oluşturulmadı)
│   ├── product_ids/                 # 67 kategori ✅
│   └── collection_auto_rawData.js   # Phase 2 scraper
│
├── trendyol/
│   ├── raw_data/                    # Ham — dokunulmaz (henüz oluşturulmadı)
│   ├── product_ids/                 # 809 kategori ✅
│   └── collection_auto_rawData.js   # Phase 2 scraper (GID counter → shared)
│
├── pipeline/
│   ├── transform_n11.js             # n11 raw → unified JSONL + GID atama ✅
│   ├── merge.js                     # platform JSONL'lerini birleştir ✅
│   └── to_parquet.py                # JSONL → Parquet (iki şema) ✅
│
├── output/                          # Transform çıktıları (git'e eklenmez)
│   ├── n11_reviews.jsonl
│   ├── trendyol_reviews.jsonl
│   ├── all_reviews.jsonl
│   ├── parquet_by_platform/
│   └── parquet_by_platform_year/
│
├── derived/                         # Türetilmiş veriler (henüz oluşturulmadı)
│   ├── duplicate_pairs.jsonl
│   ├── author_profiles.jsonl
│   ├── seller_profiles.jsonl
│   ├── product_timeseries.jsonl
│   ├── category_anomaly.jsonl
│   └── cross_platform_products.jsonl
│
├── logs/
│   └── gid_counter.json             # Global GID sayacı (paylaşılan)
│
├── CLAUDE.md                        # Teknik dokümantasyon (scraper API, CLI flags)
└── NOTES.md                         # Bu dosya — kararlar ve sıradaki adımlar
```

---

## npm Komutları (Tam Liste)

### N11
```bash
npm run scrape_product        # Phase 1: product ID topla
npm run scrape_review_def     # Phase 2: concurrency 3
npm run scrape_arda           # Phase 2: arda'nın kategorileri
npm run scrape_tugce          # Phase 2: tugce'nin kategorileri
npm run scrape_havvagul       # Phase 2: havvagul'un kategorileri
npm run failed_scrapes        # Başarısız job'ları tekrar dene
npm run previous_scrapes      # Yarım kalan run'ları listele
```

### Trendyol
```bash
npm run scrape_ty_arda
npm run scrape_ty_tugce
npm run scrape_ty_havvagul
npm run scrape_ty_failed
npm run scrape_ty_partial
```

### Pipeline
```bash
npm run transform_n11    # n11 raw → output/n11_reviews.jsonl
npm run merge_reviews    # output/all_reviews.jsonl
npm run to_parquet       # output/parquet_*/
```
