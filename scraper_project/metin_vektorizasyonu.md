# Metin Vektörizasyonu — Kapsamlı Konu Anlatımı

> **Hedef:** Makine öğrenmesi algoritmaları sayılarla çalışır, metinlerle değil. Vektörizasyon, ham metni sayısal bir forma dönüştürme işlemidir. Bu doküman, fake review detection projesinde kullanılacak yöntemleri en temelden en ileri seviyeye kadar açıklar.

---

## İçindekiler

1. [Neden Vektörizasyon?](#1-neden-vektorizasyon)
2. [Temel Kavramlar](#2-temel-kavramlar)
3. [Bag of Words (BoW)](#3-bag-of-words-bow)
4. [TF-IDF](#4-tf-idf)
5. [N-gram Modeller](#5-n-gram-modeller)
6. [Word Embeddings — Word2Vec](#6-word-embeddings--word2vec)
7. [FastText](#7-fasttext)
8. [BERT ve Bağlamsal Embeddingler](#8-bert-ve-baglamsal-embeddingler)
9. [Yöntem Karşılaştırması](#9-yontem-karsilastirmasi)
10. [Türkçe için Özel Notlar](#10-turkce-icin-ozel-notlar)
11. [Fake Review Projesine Uygulanması](#11-fake-review-projesine-uygulanmasi)
12. [Kod Örnekleri](#12-kod-ornekleri)

---

## 1. Neden Vektörizasyon?

Bir makine öğrenmesi modeli, örneğin Random Forest veya XGBoost, şu soruyu sorar: *"Bu veri noktasının özellikleri neler?"* Özellikler sayı olmalıdır. Ama elimizde şu var:

```
"Bu ürünü çok beğendim, herkese tavsiye ederim!"
```

Bu string'i doğrudan bir modele veremezsiniz. Vektörizasyon bu dönüşümü sağlar:

```
"Bu ürünü çok beğendim..." → [0.0, 0.23, 0.0, 0.87, 0.0, 0.45, ...]
                                        ↑
                              her boyut bir anlam taşır
```

Üretilen bu sayı dizisine **vektör** denir. Vektörizasyonun kalitesi, modelin başarısını doğrudan belirler.

---

## 2. Temel Kavramlar

Devam eden bölümlerde sürekli karşılaşacağınız terimler:

### Corpus (Derlem)

İşlenecek tüm belgeler koleksiyonu. Bizim projemizde corpus = tüm yorumlar.

```
Corpus:
  Belge 1: "Ürün çok kaliteliydi"
  Belge 2: "Kargo geç geldi ama ürün güzel"
  Belge 3: "Sahte ürün, aldatıldım"
  ...
  Belge N: (milyonlarca yorum)
```

### Token

Metnin en küçük anlamlı birimi. Genellikle kelime, ama bazen karakter veya alt-kelime olabilir.

```
"Ürün çok güzel"  →  ["Ürün", "çok", "güzel"]   (3 token)
```

### Tokenization (Belirteçleme)

Metni token'lara ayırma işlemi. Boşluklara böl, noktalama temizle, küçük harfe çevir.

```python
text = "Ürün ÇOK güzeldi! Herkese tavsiye ederim."
tokens = ["ürün", "çok", "güzeldi", "herkese", "tavsiye", "ederim"]
```

### Vocabulary (Kelime Haznesi)

Corpus'taki tüm unique token'ların kümesi. Eğer 1 milyon yorumda 200.000 farklı kelime varsa, vocabulary boyutu 200.000'dir.

### Sparse vs Dense Vektör

- **Sparse (seyrek):** Çoğu değeri sıfır olan vektör. BoW ve TF-IDF üretir. Boyut = vocabulary boyutu (200.000+).
- **Dense (yoğun):** Her değeri anlamlı olan kompakt vektör. Word2Vec/BERT üretir. Boyut = 100–768.

---

## 3. Bag of Words (BoW)

### Temel Fikir

Bir metnin "anlam torbası" gibi düşünün. Kelimelerin sırasını unutun; hangi kelimeler kaç kez geçiyor, sadece buna bakın.

```
Corpus:
  D1: "güzel ürün güzel paket"
  D2: "kötü ürün çok kötü"
  D3: "güzel kargo hızlı kargo"
```

**Adım 1 — Vocabulary oluştur:**

```
["çok", "güzel", "hızlı", "kargo", "kötü", "paket", "ürün"]
   0      1        2        3        4        5        6
```

**Adım 2 — Her belge için sayım vektörü:**

| Belge | çok | güzel | hızlı | kargo | kötü | paket | ürün |
|-------|-----|-------|-------|-------|------|-------|------|
| D1    | 0   | 2     | 0     | 0     | 0    | 1     | 1    |
| D2    | 1   | 0     | 0     | 0     | 2    | 0     | 1    |
| D3    | 0   | 1     | 1     | 2     | 0    | 0     | 0    |

D1 vektörü: `[0, 2, 0, 0, 0, 1, 1]`

### Yorumlama

Her vektör boyutu bir kelimeye karşılık gelir. Değer, o kelimenin o belgede kaç kez geçtiğidir.

### Sorunlar

**1. Kelime sırası kaybolur:**

```
"Ürün güzel değil"  →  [0, 1, 0, 0, 0, 0, 1, 1]
"Ürün güzel"        →  [0, 1, 0, 0, 0, 0, 0, 1]
```
"Güzel değil" ile "güzel" çok benzer görünür — ki anlam tamamen zıt.

**2. Sık kelimeler anlamsız gürültü yaratır:**

"ve", "bir", "bu", "için" gibi kelimeler her yorumda geçer ama anlam taşımaz. Bunlara **stopword** denir ve genellikle filtrelenir.

**3. Yüksek boyutluluk:**

200.000 kelimelik vocabulary → her vektör 200.000 boyutlu. Ama her belgede sadece ~50 farklı kelime var → vektörün %99.97'si sıfır. Bu **curse of dimensionality** sorununa yol açar.

### Ne Zaman Kullanılır?

BoW tek başına nadiren kullanılır. TF-IDF'e temel oluşturur ve bazı basit classifierlar için yeterlidir.

---

## 4. TF-IDF

### Temel Fikir

BoW'un sorunu: "güzel" kelimesi her yorumda geçiyorsa, bir yorumu diğerinden ayırt etmez. Önemli olan, **bir belgede sık geçen ama tüm corpus'ta nadir geçen** kelimeler.

TF-IDF = **Term Frequency × Inverse Document Frequency**

### TF — Term Frequency

Bir kelimenin **tek bir belgede** ne kadar sık geçtiğinin ölçüsü.

```
TF(t, d) = (t'nin d'de geçme sayısı) / (d'deki toplam token sayısı)
```

Örnek:
```
D1: "güzel ürün güzel paket"  →  toplam 4 token
TF("güzel", D1) = 2/4 = 0.50
TF("ürün",  D1) = 1/4 = 0.25
TF("paket", D1) = 1/4 = 0.25
```

### IDF — Inverse Document Frequency

Bir kelimenin **tüm corpus'ta** ne kadar nadir olduğunun ölçüsü.

```
IDF(t) = log( N / df(t) )
```

Burada:
- `N` = toplam belge sayısı
- `df(t)` = t kelimesini içeren belge sayısı

```
N = 3 belge
"güzel" → 2 belgede geçiyor  →  IDF = log(3/2) = 0.405
"kargo" → 1 belgede geçiyor  →  IDF = log(3/1) = 1.099
"ürün"  → 2 belgede geçiyor  →  IDF = log(3/2) = 0.405
```

"Kargo" daha nadir → daha yüksek IDF → daha **ayırt edici**.

### TF-IDF Skoru

```
TF-IDF(t, d) = TF(t, d) × IDF(t)
```

D1 için:
```
TF-IDF("güzel", D1) = 0.50 × 0.405 = 0.202
TF-IDF("kargo", D1) = 0.00 × 1.099 = 0.000   ← D1'de "kargo" yok
TF-IDF("ürün",  D1) = 0.25 × 0.405 = 0.101
```

### Sezgisel Anlam

| Durum | TF | IDF | TF-IDF | Yorum |
|---|---|---|---|---|
| Belgede sık, corpus'ta nadir | Yüksek | Yüksek | **Çok yüksek** | Bu belgenin anahtar kelimesi |
| Belgede sık, corpus'ta yaygın | Yüksek | Düşük | Orta | Genel kelime |
| Belgede nadir, corpus'ta nadir | Düşük | Yüksek | Düşük | Çok spesifik, az önemli |
| Belgede nadir, corpus'ta yaygın | Düşük | Düşük | **Çok düşük** | Stopword gibi, önemsiz |

### Fake Review İçin Önemi

"sahte", "aldatıldım", "kalitesiz" gibi kelimeler corpus'ta nadir geçer → yüksek IDF → bu yorumları güçlü şekilde temsil eder. TF-IDF bu tür kelimeler için modele güçlü sinyal verir.

### Sklearn ile Kullanım

```python
from sklearn.feature_extraction.text import TfidfVectorizer

corpus = ["güzel ürün beğendim", "kötü ürün aldatıldım", "hızlı kargo güzel paket"]

vectorizer = TfidfVectorizer(max_features=10000, ngram_range=(1, 2))
X = vectorizer.fit_transform(corpus)

# X: sparse matrix, shape = (3 belge, 10000 özellik)
print(X.shape)  # (3, 10000)
```

### Sınırlılıklar

- Hâlâ bag-of-words mantığı → kelime sırası yok.
- Anlam yok: "güzel" ile "harika" farklı boyutlar, ama anlam olarak yakın.
- Synonymy (eş anlamlı) ve polysemy (çok anlamlı) sorunları.

---

## 5. N-gram Modeller

### Temel Fikir

BoW ve TF-IDF tek kelimelere bakar (1-gram / unigram). N-gram, arka arkaya gelen N kelimeyi bir birim olarak ele alır.

```
"Ürün çok güzel ama kargo geç geldi"

Unigram (1-gram): ["ürün", "çok", "güzel", "ama", "kargo", "geç", "geldi"]
Bigram  (2-gram): ["ürün çok", "çok güzel", "güzel ama", "ama kargo", "kargo geç", "geç geldi"]
Trigram (3-gram): ["ürün çok güzel", "çok güzel ama", "güzel ama kargo", ...]
```

### Neden Önemli?

```
"güzel değil"  →  1-gram: ["güzel", "değil"]   — iki ayrı özellik
                  2-gram: ["güzel değil"]        — olumsuzlamayı yakalar!
```

TF-IDF'e bigram eklemek, olumsuz ifadeleri, kalıplaşmış deyimleri ve bağlamı kısmen yakalamaya yarar.

### Önerilen Kullanım

```python
TfidfVectorizer(ngram_range=(1, 2))  # Unigram + bigram birlikte
```

`(1, 2)` demek: hem 1-gram hem 2-gram özelliklerini kullan. Vocabulary büyür (50K → 300K) ama model genellikle daha iyi hale gelir.

### Trade-off

| ngram_range | Vocabulary boyutu | Hafıza | Zaman | Kalite |
|---|---|---|---|---|
| (1,1) | Küçük | Az | Hızlı | Temel |
| (1,2) | Orta | Orta | Orta | İyi |
| (1,3) | Büyük | Çok | Yavaş | Bazen iyi |

---

## 6. Word Embeddings — Word2Vec

### Motivasyon

TF-IDF'in temel problemi: "güzel" ve "harika" tamamen farklı vektör boyutlarıdır, ama anlamca yakındır. Embeddingler bu sorunu çözer: anlamca benzer kelimeler vektör uzayında birbirine yakın olur.

### Ana Fikir: Dağıtımsal Hipotez

> *"Bir kelimenin anlamı, yanında sıklıkla hangi kelimelerin geçtiğiyle belirlenir."*
> — Firth, 1957

"Köpek" kelimesi genellikle "havlar", "mama", "tasma" yanında geçer. "Kedi" de benzer bağlamlarda geçer. Dolayısıyla ikisi benzer vektörlere sahip olmalıdır.

### Mimariler

Word2Vec iki farklı mimariyle eğitilebilir:

**CBOW (Continuous Bag of Words)**

Bağlamdaki kelimelerden merkez kelimeyi tahmin et.

```
["Ürün", "çok", "___", "ama"] → "güzel" tahmin et
```

**Skip-gram**

Merkez kelimeden bağlam kelimelerini tahmin et.

```
"güzel" → ["Ürün", "çok", "ama"] tahmin et
```

Skip-gram nadir kelimeler için daha iyidir. CBOW daha hızlıdır.

### Eğitim Süreci (Basitleştirilmiş)

```
1. Her kelimeye rastgele bir vektör ata (boyut = 100-300)
2. Milyonlarca cümle üzerinde:
   - "güzel" kelimesini gördüğünde, yanındaki kelimelerin tahmin edilebilir olmasını sağla
   - Geri yayılım ile vektörleri güncelle
3. Benzer bağlamlarda geçen kelimelerin vektörleri yaklaşır
```

### Vektör Aritmetiği — Ünlü Örnek

```python
king - man + woman ≈ queen
```

Bu gerçekten çalışır! Vektör uzayında anlamsal ilişkiler kodlanır.

Bizim projemiz için:
```python
"sahte" - "gerçek" ≈ "fake" bölgesini işaret edebilir
```

### Review'ı Nasıl Temsil Ederiz?

Word2Vec her kelimeye bir vektör verir, ama biz tüm review'ı temsil etmek istiyoruz.

**Yöntem 1 — Ortalama Havuzlama (Mean Pooling):**

```
review = ["ürün", "çok", "güzel"]
vektör = mean(v("ürün"), v("çok"), v("güzel"))
```

Her boyut ortalaması alınır. Basit ama etkili.

**Yöntem 2 — Ağırlıklı Ortalama:**

TF-IDF skoru × kelime vektörü. Önemli kelimelere daha fazla ağırlık.

### Gensim ile Kullanım

```python
from gensim.models import Word2Vec

# Eğitim (kendi verisiyle)
sentences = [["güzel", "ürün", "beğendim"], ["kötü", "ürün", "iade"]]
model = Word2Vec(sentences, vector_size=100, window=5, min_count=2, workers=4)

# Kelime vektörü
model.wv["güzel"]           # shape: (100,)

# Benzer kelimeler
model.wv.most_similar("güzel")
# [("harika", 0.89), ("mükemmel", 0.87), ("iyi", 0.85), ...]

# Review vektörü (ortalama havuzlama)
import numpy as np
tokens = ["güzel", "ürün", "beğendim"]
review_vec = np.mean([model.wv[t] for t in tokens if t in model.wv], axis=0)
# review_vec: shape (100,)
```

### Sınırlılıklar

Word2Vec her kelimeye **tek bir** vektör atar. Ama "banka" kelimesi hem "finans kurumu" hem "nehir kıyısı" anlamına gelir. Bağlama göre farklı vektörler gerekir → BERT bunu çözer.

---

## 7. FastText

### Word2Vec'ten Farkı

Word2Vec kelime düzeyinde çalışır. FastText **karakter n-gram** (alt-kelime) düzeyinde çalışır.

```
"çalışıyor"
→ karakter trigramlar: ["çal", "alı", "lış", "ışı", "şıy", "ıyo", "yor"]
→ kelime vektörü = bu trigramların vektörlerinin toplamı
```

### Neden Türkçe İçin Kritik?

Türkçe sonekle zengin bir dil (agglutinative). Aynı kelime kökü onlarca farklı formda gelebilir:

```
"güzel", "güzele", "güzeldi", "güzeldir", "güzelleşti", "güzelleştirilmiş"
```

Word2Vec her birini farklı kelime olarak görür. Eğitim setinde "güzelleştirilmiş" geçmemişse, bu kelime için vektör üretemez (OOV — Out of Vocabulary problemi).

FastText "güzelleştirilmiş" kelimesini görmemiş olsa bile, karakter n-gramlarından makul bir vektör türetebilir.

### Pre-trained Türkçe FastText

Facebook, büyük Türkçe metinler üzerinde eğitilmiş hazır modeller sunar:

```python
import fasttext.util
fasttext.util.download_model('tr', if_exists='ignore')  # Türkçe model
ft = fasttext.load_model('cc.tr.300.bin')

ft.get_word_vector("güzelleştirilmiş")  # shape: (300,)  — OOV kelime için de çalışır!
ft.get_nearest_neighbors("sahte")       # Anlam yakınlığı
```

### Review Vektörü

```python
# FastText doğrudan review vektörü üretir
review_vec = ft.get_sentence_vector("Bu ürün çok güzeldi gerçekten")
# shape: (300,)
```

### Avantajlar

- OOV kelimeler için vektör üretir (Türkçe için çok önemli)
- Yazım hataları için robust: "güzzzel" → "güzel"e yakın vektör
- Hızlı çıkarım
- Pre-trained Türkçe model mevcut

---

## 8. BERT ve Bağlamsal Embeddingler

### Önceki Yöntemlerin Ortak Sorunu

Word2Vec ve FastText her kelimeye **tek, sabit** bir vektör atar. Ama:

```
"Bu banka çok iyi" → "banka" = finans kurumu
"Nehrin bankasında oturdum" → "banka" = kıyı
```

Her iki cümlede "banka" aynı vektörle temsil edilir — bu yanlış.

### BERT'in Çözümü: Bağlamsal Vektörler

BERT (Bidirectional Encoder Representations from Transformers), tüm cümleyi birden işler ve her kelimenin vektörünü **bağlamına göre** üretir.

```
"Bu banka çok iyi"
   ↓
BERT
   ↓
"banka" vektörü = finans bağlamında bir vektör

"Nehrin bankasında oturdum"
   ↓
BERT
   ↓
"banka" vektörü = coğrafi bağlamda farklı bir vektör
```

### Transformer Mimarisi (Basit Açıklama)

BERT'in temelinde **Attention Mekanizması** vardır.

```
Cümle: "Ürün güzel ama satıcı aldatıcı"
```

"aldatıcı" kelimesinin vektörü hesaplanırken, model tüm diğer kelimelere ne kadar "dikkat" edeceğini öğrenir:

```
"aldatıcı" ← "satıcı"   (yüksek dikkat: kim aldatıcı?)
"aldatıcı" ← "güzel"    (düşük dikkat: zıt bağlam)
"aldatıcı" ← "ama"      (orta dikkat: kontrast belirtiyor)
```

Bu dikkat ağırlıkları, bağlamsal vektörü oluşturur.

### BERT'in Eğitimi

BERT iki görevle ön-eğitim görür:

**1. Masked Language Model (MLM):**

```
Girdi:  "Ürün [MASK] ama satıcı aldatıcı"
Hedef:  "güzel" tahmin et
```

**2. Next Sentence Prediction (NSP):**

```
Cümle A: "Ürün güzel."
Cümle B: "Satıcı aldatıcı."
Bu iki cümle gerçekten ardışık mı? → Evet/Hayır sınıflandır
```

Milyarlarca cümle üzerinde eğitilen model, dili derin biçimde öğrenir.

### BERTurk — Türkçe BERT

`dbmdz/bert-base-turkish-cased` modeli büyük Türkçe metin derlemleri üzerinde eğitilmiştir.

```python
from transformers import AutoTokenizer, AutoModel
import torch

tokenizer = AutoTokenizer.from_pretrained("dbmdz/bert-base-turkish-cased")
model = AutoModel.from_pretrained("dbmdz/bert-base-turkish-cased")

text = "Bu ürün çok güzeldi gerçekten"
inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512)

with torch.no_grad():
    outputs = model(**inputs)

# CLS token → tüm cümlenin özet vektörü (boyut: 768)
sentence_vec = outputs.last_hidden_state[:, 0, :]
print(sentence_vec.shape)  # torch.Size([1, 768])
```

### Fine-tuning

BERT ön-eğitimli ağırlıklarla gelir. Kendi verinizde ince ayar (fine-tuning) yaparak özel göreviniz için optimize edebilirsiniz:

```
BERTurk (pre-trained) 
    +
Review verisi (label'lı)
    ↓
Fine-tuned model → "Sahte / Gerçek" sınıflandırması
```

### Sınırlılıklar

- Yavaş: 512 token limit, her inference ~ms-cinsinden (GPU'suz çok yavaş)
- Büyük model: ~440MB RAM
- Label'lı veri gerektirir fine-tuning için
- GPU olmadan production'da zorlanır

---

## 9. Yöntem Karşılaştırması

| Özellik | BoW | TF-IDF | Word2Vec | FastText | BERT |
|---|---|---|---|---|---|
| **Vektör boyutu** | 50K–500K | 50K–500K | 100–300 | 300 | 768 |
| **Sparse mi?** | Evet | Evet | Hayır | Hayır | Hayır |
| **Kelime sırası** | Hayır | Hayır | Kısmen | Kısmen | Evet |
| **OOV kelime** | Yok | Yok | Yok | Var | Var |
| **Bağlamsal anlam** | Hayır | Hayır | Hayır | Hayır | Evet |
| **Türkçe uyumu** | Zayıf | Zayıf | Orta | İyi | Çok iyi |
| **Hız** | Çok hızlı | Çok hızlı | Hızlı | Hızlı | Yavaş |
| **GPU gerektirir mi?** | Hayır | Hayır | Hayır | Hayır | İdeal ama zorunlu değil |
| **Yorumlanabilirlik** | Yüksek | Yüksek | Orta | Orta | Düşük |
| **Veri gereksinimi** | Az | Az | Orta | Az (pre-trained) | Az (pre-trained ile) |

### Hangi Durumda Ne Kullanılır?

```
Label'lı veri yok henüz → TF-IDF + unsupervised (Isolation Forest)
İlk supervised baseline    → TF-IDF (1,2) + XGBoost / Logistic Regression
Türkçe'ye özel güç         → FastText pre-trained + gradient boosting
Yüksek doğruluk hedefi     → BERTurk fine-tuning
```

---

## 10. Türkçe İçin Özel Notlar

### Morfoloji Sorunu

Türkçe'de bir fiil yüzlerce farklı ekle gelebilir:

```
"gel", "geldi", "gelmedi", "geleceğim", "gelmeyecektim", 
"gelebilirdim", "getirilemiyor", "getirilememişti" ...
```

BoW/TF-IDF bunların hepsini farklı kelime sayar. Çözümler:

**Stemming:** Kelimenin kökünü bul (kaba, bazen yanlış).

```python
# Snowball stemmer (Türkçe desteği kısıtlı)
from nltk.stem.snowball import SnowballStemmer
stemmer = SnowballStemmer("turkish")
stemmer.stem("gelmeyecektim")  # "gel" (ideal) veya yaklaşık bir kök
```

**Lemmatization:** Tam sözlük biçimine döndür (daha doğru, daha yavaş).

Zemberek (Java) en kapsamlı Türkçe NLP aracıdır. Python için `zemberek-python` wrapper'ı mevcuttur.

### Stopword Listesi

Türkçe stopword'ler TF-IDF'ten önce temizlenmelidir:

```python
turkish_stopwords = ["ve", "bir", "bu", "da", "de", "ile", "için", "ama", 
                     "çok", "daha", "en", "ne", "ki", "mi", "mu", "mü",
                     "var", "yok", "gibi", "kadar", "veya", ...]

# NLTK veya spaCy Türkçe modeli de stopword listesi sağlar
```

> **Dikkat:** Fake review detection'da "çok" ve "en" gibi aşırı kelimeler (superlative markers) ayırt edici olabilir. Stopword listesini körce uygulamayın — önce analiz edin.

### Karakter Normalizasyonu

```python
import unicodedata

def normalize_turkish(text):
    # Küçük harf (Türkçe'ye duyarlı)
    text = text.lower()
    # i → ı, I → İ sorunlarına dikkat
    text = text.replace("i̇", "i")
    # Tekrar eden karakterleri normalize et: "güzzzel" → "güzel"
    # (Sahte yorumlar sıklıkla bunu yapar)
    import re
    text = re.sub(r'(.)\1{2,}', r'\1', text)
    return text
```

---

## 11. Fake Review Projesine Uygulanması

### Hangi Vektörizasyon Stratejisi?

Projenizin mevcut durumuna göre öneri:

**Aşama 1 (Şimdi) — Label yok:**

```python
# TF-IDF vektörü + Isolation Forest
vectorizer = TfidfVectorizer(max_features=50000, ngram_range=(1, 2))
X_text = vectorizer.fit_transform(reviews["comment"])

# Metadata özelliklerini ekle
X_meta = reviews[["rating_score", "helpful_votes", "image_count"]].values
from scipy.sparse import hstack
X = hstack([X_text, X_meta])

from sklearn.ensemble import IsolationForest
clf = IsolationForest(contamination=0.05)  # %5 sahte varsayımı
anomaly_scores = clf.fit_predict(X)
```

**Aşama 2 (Label sonrası) — Supervised:**

```python
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

pipeline = Pipeline([
    ("tfidf", TfidfVectorizer(max_features=100000, ngram_range=(1,2))),
    ("clf",   LogisticRegression(class_weight="balanced", C=1.0))
])
pipeline.fit(X_train, y_train)
```

**Aşama 3 (Uzun vadeli) — FastText + Gradient Boosting:**

```python
import fasttext
import numpy as np
import xgboost as xgb

ft = fasttext.load_model("cc.tr.300.bin")

def get_review_vector(text):
    return ft.get_sentence_vector(text)  # shape: (300,)

X_text = np.array([get_review_vector(r) for r in reviews["comment"]])
X_meta = reviews[["rating_score", "helpful_votes", "image_count"]].values
X = np.hstack([X_text, X_meta])  # shape: (N, 303)

clf = xgb.XGBClassifier(scale_pos_weight=20)  # imbalanced dataset
clf.fit(X_train, y_train)
```

### Hybrid Strateji: Metin + Metadata

Sadece metin vektörü yeterli değildir. Metadata özelliklerini her zaman ekleyin:

```python
features = {
    # Metin vektörü (TF-IDF veya embedding)
    "text_vector": ...,
    
    # Davranışsal özellikler
    "rating_score":        review["rating_score"],
    "helpful_votes":       review["helpful_votes"],
    "image_count":         review["image_count"],
    
    # Türetilmiş özellikler
    "review_length":       len(review["comment"].split()),
    "exclamation_count":   review["comment"].count("!"),
    "rating_deviation":    review["rating_score"] - product_avg_rating,
    "is_verified":         review["is_verified"],
}
```

---

## 12. Kod Örnekleri

### Tam TF-IDF Pipeline

```python
import pandas as pd
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
from scipy.sparse import hstack
import re

# --- 1. Metin Temizleme ---
def clean_text(text):
    if not isinstance(text, str):
        return ""
    text = text.lower()
    text = re.sub(r'(.)\1{2,}', r'\1', text)      # "çooook" → "çok"
    text = re.sub(r'[^\w\sğüşıöçĞÜŞİÖÇ]', ' ', text)  # noktalama temizle
    text = re.sub(r'\s+', ' ', text).strip()
    return text

# --- 2. Vektörizasyon ---
vectorizer = TfidfVectorizer(
    max_features=100_000,
    ngram_range=(1, 2),
    min_df=3,           # En az 3 belgede geçen kelimeler
    max_df=0.95,        # Tüm belgelerin %95'inden fazlasında geçenleri at
    sublinear_tf=True,  # TF'ye log uygula: 1 + log(tf)
)

# df: reviews DataFrame, "comment" ve "label" sütunları mevcut
df["clean_comment"] = df["comment"].apply(clean_text)

X_text = vectorizer.fit_transform(df["clean_comment"])

# --- 3. Metadata Özellikler ---
meta_features = df[["rating_score", "helpful_votes", "image_count"]].fillna(0).values
from scipy.sparse import csr_matrix
X_meta = csr_matrix(meta_features)

X = hstack([X_text, X_meta])
y = df["label"]  # 0 = gerçek, 1 = sahte

# --- 4. Model ---
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)

model = LogisticRegression(
    class_weight="balanced",  # imbalanced dataset için kritik
    max_iter=1000,
    C=1.0,
)
model.fit(X_train, y_train)

# --- 5. Değerlendirme ---
y_pred = model.predict(X_test)
print(classification_report(y_test, y_pred, target_names=["Gerçek", "Sahte"]))

# --- 6. En Önemli Özellikler ---
feature_names = vectorizer.get_feature_names_out()
coef = model.coef_[0][:len(feature_names)]

top_fake_indicators = sorted(zip(coef, feature_names), reverse=True)[:20]
print("\nSahte yorum göstergeleri:")
for coef, word in top_fake_indicators:
    print(f"  {word:30s} {coef:+.4f}")
```

### FastText Vektörizasyon

```python
import fasttext
import numpy as np
import json
import os

# Model yükleme (ilk seferinde indirir ~4GB)
import fasttext.util
fasttext.util.download_model('tr', if_exists='ignore')
ft = fasttext.load_model('cc.tr.300.bin')

def get_fasttext_features(reviews_df):
    """Review DataFrame'inden FastText vektörlerini çıkar."""
    vectors = []
    for text in reviews_df["clean_comment"]:
        vec = ft.get_sentence_vector(str(text))
        vectors.append(vec)
    return np.array(vectors)  # shape: (N, 300)

# Review vektörleri
X_text = get_fasttext_features(df)

# Metadata birleştir
X_meta = df[["rating_score", "helpful_votes", "image_count"]].fillna(0).values
X = np.hstack([X_text, X_meta])  # shape: (N, 303)

print(f"Feature matrix: {X.shape}")
```

### BERTurk Inference

```python
from transformers import AutoTokenizer, AutoModel
import torch
import numpy as np

MODEL_NAME = "dbmdz/bert-base-turkish-cased"
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModel.from_pretrained(MODEL_NAME)
model.eval()

def bert_encode(texts, batch_size=32):
    """Metinleri batch halinde BERTurk vektörlerine dönüştür."""
    all_vecs = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        encoded = tokenizer(
            batch,
            padding=True,
            truncation=True,
            max_length=256,
            return_tensors="pt"
        )
        with torch.no_grad():
            output = model(**encoded)
        # CLS token vektörü = cümle temsili
        cls_vecs = output.last_hidden_state[:, 0, :].numpy()
        all_vecs.append(cls_vecs)
        
        if i % 1000 == 0:
            print(f"İşlendi: {i}/{len(texts)}")
    
    return np.vstack(all_vecs)  # shape: (N, 768)

texts = df["clean_comment"].tolist()
X_bert = bert_encode(texts)
print(f"BERT feature matrix: {X_bert.shape}")  # (N, 768)
```

---

## Özet

```
Ham Metin
    ↓
Temizleme (lowercase, normalizasyon, stopword)
    ↓
Tokenization
    ↓
Vektörizasyon:
  ├── TF-IDF       → Sparse, hızlı, yorumlanabilir  [Başlangıç]
  ├── FastText TR  → Dense, Türkçe'ye güçlü          [Ara hedef]
  └── BERTurk      → Dense, bağlamsal, en güçlü      [Nihai hedef]
    ↓
+ Metadata Özellikleri (rating, verified, image_count...)
    ↓
ML Modeli (XGBoost, Random Forest, Logistic Regression)
    ↓
label_confidence → sahte mi, gerçek mi?
```

---

*Son güncelleme: Haziran 2026 — Review AI / Fake Review Detection Projesi*
