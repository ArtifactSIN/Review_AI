# Yapay Zeka Destekli Sahte Yorum Tespit Sistemi

Bu proje, e-ticaret platformlarında bulunan **sahte, yanıltıcı ve yapay olarak üretilmiş yorumları tespit etmek** amacıyla geliştirilen **Yapay Zeka ve Makine Öğrenmesi tabanlı bir sistemdir**.

---

## 🎯 Projenin Amacı

Günümüzde e-ticaret sitelerinde:

- bot hesaplar,
- otomatik sistemler,
- manipülatif mağaza davranışları

nedeniyle çok sayıda sahte yorum üretilmektedir.

Bu proje ile amaçlanan:

- sahte yorumları tespit etmek,
- kullanıcı güvenini artırmak,
- daha adil bir rekabet ortamı oluşturmak.

---

## ⚙️ Sistem Mimarisi

Proje 3 ana aşamadan oluşur:

### 1. Yorum Toplama (Scraper) ✅
- Ürün ve kategori bazlı yorum toplama
- Raw veri oluşturma
- Resume, retry ve checkpoint sistemi

### 2. Veri İşleme 🔄
- Veri temizleme
- Feature çıkarımı
- Dataset oluşturma

### 3. Yapay Zeka / ML Sistemi 🚀
Kullanılacak modeller:
- Naive Bayes
- SVM
- Random Forest
- K-Means
- LSTM (Deep Learning)

---

## 📁 Proje Yapısı

### application_to_2209/
- TÜBİTAK proje dokümanları

### scraper_project/
- Yorum toplama sistemi (data layer)

---

## 🚀 Mevcut Durum

### ✅ Tamamlananlar
- Tam fonksiyonel scraper sistemi
- Loglama ve hata yönetimi
- Resume ve retry mekanizması
- Team-based scraping sistemi
- Partial save sistemi

### 🔄 Devam Eden
- Veri toplama süreci
- Kategori bazlı ilerleme

### 🚀 Sonraki Adım
- ML modeli eğitimi
- Sahte yorum tespiti

---

## 🎯 Nihai Hedef

- Sahte yorumları otomatik tespit eden sistem
- Kullanıcı güvenini artıran yapı
- E-ticaret için daha şeffaf ortam
