#!/usr/bin/env node
// n11 Review Scraper için Türkçe komut referansı.
// Çalıştırmak için: npm run scrape_yardim

const lines = `
╔══════════════════════════════════════════════════════════════╗
║        n11 Review Scraper — Komut Referansı (TR)             ║
╚══════════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AŞAMA 1 — ÜRÜN ID'LERİNİ TOPLA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run scrape_product
  categories.txt içindeki her kategori URL'sini okur, her kategoride
  sayfa sayfa ilerleyerek (2. sayfadan başlayarak) en fazla 1.000 benzersiz
  ürün ID'si toplar ve product_ids/<slug>_ids.json dosyasına kaydeder.
    • 3 eş zamanlı worker
    • Sayfa istekleri arasında 250 ms temel gecikme + rastgele jitter
    • Kategori başına en fazla 200 sayfa
    • Tekrar eden sayfa tespit edilirse erken durur (liste sonu koruması)
    • Ctrl+C ile zararlı kapatma — kısmi sonuçlar kaydedilir

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AŞAMA 2 — YORUMLARI TOPLA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run scrape_review_def
  product_ids/ klasöründeki tüm ürünler için yorum toplar.
  Tamamlanan veriler raw_data/<kategori>/<productId>_reviews.json
  dosyasına kaydedilir. Varsayılan concurrency: 3.
    • Sayfa istekleri arasında 350 ms temel gecikme + rastgele jitter
    • Ürün başına en fazla 500 yorum sayfası
    • Her 5 sayfada bir .partial.json checkpoint kaydeder
    • Hata durumunda 1,2 s aralıkla 3 yeniden deneme
    • Zaten tamamlanmış ürünleri atlar
    • Kaydetmeden önce yorumları ID'ye göre tekilleştirir

npm run scrape_review_4
  scrape_review_def ile aynı, ancak 4 eş zamanlı worker kullanır.
  Daha hızlı — ekstra bant genişliğiniz varsa tercih edin.

npm run scrape_review_5
  scrape_review_def ile aynı, ancak 5 eş zamanlı worker kullanır.
  En hızlı seçenek — acele bitirmeniz gerektiğinde kullanın.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 TAKIM KISAYOLLARI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Her takım üyesinin önceden atanmış sabit kategorileri vardır.
Önceden atanmamış kategoriler otomatik olarak en az yüke sahip
takım üyesine dengelenir.

npm run scrape_arda
  Yalnızca Arda'ya atanmış kategoriler için yorum toplar.
  Atanan kategoriler: kitap, dekorasyon, telefon, ses-sistemleri,
  motosiklet, kadin-bakim, su-sporlari, yuz-ve-vucut-bakimi,
  cinsel-urunler, supermarket, beslenme, bilgisayar, video-oyun,
  bebek-giyim, bireysel-ve-takim-sporlari, emzirme, guzellik-salonu,
  kis-sporlari, televizyon-ve-ses-sistemleri

npm run scrape_tugce
  Yalnızca Tugce'ye atanmış kategoriler için yorum toplar.
  Atanan kategoriler: kadin-giyim-aksesuar, outdoor,
  erkek-giyim-aksesuar, evcil-hayvan, yedek-parca, bisiklet,
  elektrikli-ev-aletleri, lastik-ve-jant, mutfak, spor-giyim,
  avcilik, erkek-bakim, mobilya, bebek-bezi, biberon, dugun-davet,
  fotograf, ilginc-akilli, tekne

npm run scrape_havvagul
  Yalnızca Havvagul'a atanmış kategoriler için yorum toplar.
  Atanan kategoriler: parfum-ve-deodorant, saglik-ve-medikal,
  ev-tekstili, kirtasiye, beyaz-esya, yetiskin-hobi, muzik, sac-bakim,
  bebek-odasi, makyaj, cocuk-oyuncaklari, fitness, yapi-market,
  bebek-guvenlik, dijital-kodlar, film, hamile-giyim, oto-koltugu,
  yurutec, yasam-ve-etkinlik

  İpucu — ilk N kategoriyle sınırlandırmak için:
    node collection_auto_rawData.js --team=arda 5

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 RUN YÖNETİMİ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run previous_scrapes
  Tamamlanmamış (hâlâ devam eden veya yarıda kesilmiş) run'ları listeler.
  Devam ettirmek istediğiniz run ID'sini bulmak için kullanın.

npm run all_scrapes
  Tamamlananlar dahil tüm run'ları istatistikleriyle birlikte listeler.

npm run failed_scrapes
  Son run'da başarısız olan tüm işleri yeniden dener.
  Otomatik olarak logs/failed_jobs_latest.json dosyasını okur.
  Varsayılan concurrency 3 ile çalışır.

npm run failed_scrapes_4
  failed_scrapes ile aynı, ancak concurrency 4 — daha hızlı yeniden deneme.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 YARDIM & ÖRNEKLER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run scrape_help        → İngilizce komut referansı
npm run scrape_yardim      → Bu sayfa (Türkçe)
npm run resume_help        → Yarıda kalan run'ları devam ettirme örnekleri
npm run failed_help        → Başarısız işleri yeniden deneme örnekleri
npm run named_run_help     → İsimli run başlatma örnekleri

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 DOĞRUDAN CLI BAYRAKLARI (FLAGS)
 Kullanım: node collection_auto_rawData.js [bayraklar]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

--name=<runName>
  Bu run'a bir etiket atar. Etiket log dosyası adlandırmasında kullanılır
  ve run'u daha sonra devam ettirmenize veya referans almanıza olanak sağlar.
  Örnek:
    node collection_auto_rawData.js --name=agiz-dis-bakimi

--resume-run=<runId>
  Daha önce başlatılmış bir run'ı adı/ID'si ile devam ettirir.
  Zaten tamamlanmış ürünler otomatik olarak atlanır; hiçbir iş tekrarlanmaz.
  Örnek:
    node collection_auto_rawData.js --resume-run=agiz-dis-bakimi

--concurrency=<n>
  Kaç browser worker'ının paralel çalışacağını belirler (varsayılan: 3).
  Yüksek değerler daha hızlı bitirir fakat hedef siteye daha fazla yük bindirir.
  Örnek:
    node collection_auto_rawData.js --resume-run=my-run --concurrency=6

--categories=<slug1,slug2,...>
  Run'ı yalnızca listelenen kategori slug'larıyla (virgülle ayrılmış,
  boşluksuz) filtreler. Belirli bir alt kümeyi hedeflemek için kullanışlıdır.
  Örnek:
    node collection_auto_rawData.js --categories=mobilya,telefon-ve-aksesuarlari

--products=<id1,id2,...>
  Run'ı yalnızca listelenen ürün ID'leriyle (virgülle ayrılmış) filtreler.
  Belirli ürünleri kontrol etmek veya yeniden denemek için kullanışlıdır.
  Örnek:
    node collection_auto_rawData.js --products=734699208,734700038

--team=<isim>
  Yalnızca o takım üyesine önceden atanmış kategorileri çalıştırır.
  Geçerli değerler: arda, tugce, havvagul.
  Atanmamış kategoriler en az yüklü takım üyesine dinamik olarak dağıtılır.
  Örnek:
    node collection_auto_rawData.js --team=tugce
  İlk N kategoriyle sınırlandırmak için:
    node collection_auto_rawData.js --team=havvagul 10

--failed-only
  Yalnızca geçerli başarısız işler dosyasında listelenen işleri yeniden dener.
  Varsayılan olarak logs/failed_jobs_latest.json dosyasını okur.
  Belirli bir dosyayı hedeflemek için --failed-file ile birlikte kullanılabilir.
  Örnek:
    node collection_auto_rawData.js --failed-only

--failed-file=<yol>
  Yeniden deneme için hangi başarısız işler JSON dosyasının kullanılacağını
  belirtir. --failed-only ile birlikte kullanılmalıdır.
  Örnek:
    node collection_auto_rawData.js --failed-only --failed-file=logs/agiz-dis-bakimi_failed_jobs.json

--list-runs
  Tamamlanmamış (bitmemiş) tüm run'ları tablo halinde yazdırıp çıkar.
  Eşdeğeri: npm run previous_scrapes

--list-all-runs
  Tüm run'ları (bitmişler ve bitmemişler) tablo halinde yazdırıp çıkar.
  Eşdeğeri: npm run all_scrapes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 BAYRAKLARI BİRLEŞTİRME — ÖRNEKLER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

İki kategori için 4 worker'lı isimli run başlatma:
  node collection_auto_rawData.js --name=test-run --categories=mobilya,telefon-ve-aksesuarlari --concurrency=4

O run'ı 6 worker ile devam ettirme:
  node collection_auto_rawData.js --resume-run=test-run --concurrency=6

Belirli bir log dosyasındaki başarısız işleri 4 worker ile yeniden deneme:
  node collection_auto_rawData.js --failed-only --failed-file=logs/test-run_failed_jobs.json --concurrency=4

Başarısız yeniden deneme run'ına isim vererek ayrı log oluşturma:
  node collection_auto_rawData.js --failed-only --name=retry-run --concurrency=4

Bir kategori içinde belirli ürünleri çalıştırma:
  node collection_auto_rawData.js --name=spot-check --categories=mobilya --products=734699208,734700038 --concurrency=2

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ÇIKTI DOSYALARI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
product_ids/<slug>_ids.json
  Aşama 1'de toplanan ürün ID'leri.

raw_data/<kategori>/<productId>_reviews.json
  Bir ürün için tamamlanmış yorum verisi.

raw_data/<kategori>/<productId>_reviews.partial.json
  Her 5 sayfada bir kaydedilen geçici checkpoint. Tamamlandığında silinir.

logs/<runId>.log
  Run için tam ayrıntılı log (her sayfa isteği, hata, yeniden deneme).

logs/<runId>_summary.json
  Tamamlanma istatistikleri: kuyruğa alınan, tamamlanan, başarısız iş sayısı
  ve toplanan yorum sayısı.

logs/<runId>_failed_jobs.json
  Başarısız işlerin hata mesajlarıyla birlikte listesi. --failed-file'a verin.

logs/failed_jobs_latest.json
  En son başarısız işler dosyasının kopyası/sembolik bağlantısı.
  --failed-only tarafından otomatik olarak kullanılır.

logs/current_status.json
  Bir run sırasında gerçek zamanlı olarak güncellenen worker durumu.
`.trim();

console.log(lines);
