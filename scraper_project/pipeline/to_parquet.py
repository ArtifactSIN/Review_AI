#!/usr/bin/env python3
"""
JSONL → Parquet dönüşümü
Kaynak: output/all_reviews.jsonl  (veya --source ile farklı dosya)
Çıktı : output/parquet_by_platform/         (Şema A)
        output/parquet_by_platform_year/    (Şema B)

Kullanım:
  python3 pipeline/to_parquet.py
  python3 pipeline/to_parquet.py --source output/n11_reviews.jsonl
"""

import sys
import argparse
import pandas as pd
from pathlib import Path

ROOT       = Path(__file__).parent.parent
OUTPUT_DIR = ROOT / "output"


def build(source: Path) -> None:
    print(f"Kaynak: {source}")
    print("Okunuyor...")

    df = pd.read_json(source, lines=True)
    print(f"  {len(df):,} satır yüklendi, {len(df.columns)} sütun")

    # timestamp sütununu datetime'a çevir (partition için yıl çıkarımı)
    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")

    # ── Şema A: platform bazlı ────────────────────────────────────────────────
    dest_a = OUTPUT_DIR / "parquet_by_platform"
    dest_a.mkdir(parents=True, exist_ok=True)
    df.to_parquet(
        dest_a,
        partition_cols=["platform"],
        index=False,
        compression="snappy",
        existing_data_behavior="delete_matching",
    )
    print(f"  Şema A → {dest_a}/")

    # ── Şema B: platform + yıl bazlı ─────────────────────────────────────────
    dest_b = OUTPUT_DIR / "parquet_by_platform_year"
    dest_b.mkdir(parents=True, exist_ok=True)

    df_b = df.copy()
    if "timestamp" in df_b.columns and pd.api.types.is_datetime64_any_dtype(df_b["timestamp"]):
        df_b["year"] = df_b["timestamp"].dt.year.astype("Int64")
    else:
        df_b["year"] = pd.NA

    df_b.to_parquet(
        dest_b,
        partition_cols=["platform", "year"],
        index=False,
        compression="snappy",
        existing_data_behavior="delete_matching",
    )
    print(f"  Şema B → {dest_b}/")

    # ── Özet ─────────────────────────────────────────────────────────────────
    print()
    print("─" * 45)
    print(f"Toplam satır : {len(df):,}")
    if "platform" in df.columns:
        print("Platform dağılımı:")
        for plat, count in df["platform"].value_counts().items():
            print(f"  {plat}: {count:,}")
    if "year" in df_b.columns:
        years = df_b["year"].dropna().astype(int).unique()
        print(f"Yıllar       : {sorted(years)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        default=str(OUTPUT_DIR / "all_reviews.jsonl"),
        help="Kaynak JSONL dosyası (varsayılan: output/all_reviews.jsonl)",
    )
    args = parser.parse_args()

    source = Path(args.source)
    if not source.exists():
        print(f"Hata: Kaynak dosya bulunamadı: {source}", file=sys.stderr)
        print("Önce şunu çalıştırın: node pipeline/transform_n11.js && node pipeline/merge.js", file=sys.stderr)
        sys.exit(1)

    build(source)


if __name__ == "__main__":
    main()
