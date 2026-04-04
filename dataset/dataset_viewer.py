"""Simple Tkinter viewer for JSONL/Parquet review datasets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import List, Dict, Any, Iterable, Optional

try:  # Optional dependency for Parquet files
    import pandas as pd
except ImportError:  # pragma: no cover - handled at runtime
    pd = None  # type: ignore

TEXT_KEYS = [
    "body",
    "text",
    "content",
    "review_text",
    "comment",
    "message",
    "description",
    "yorum",
]
TITLE_KEYS = ["title", "summary", "headline", "subject", "baslik", "başlık"]
AUTHOR_KEYS = [
    "author",
    "user",
    "username",
    "user_name",
    "reviewer",
    "nickname",
    "yazan",
    "kullanici",
    "kullanıcı",
]
ITEM_NAME_KEYS = ["item_name", "product_name", "name", "urun", "ürün"]
ITEM_ID_KEYS = ["item_id", "product_id", "asin", "sku", "id"]
DATE_KEYS = ["date", "review_date", "created_at", "timestamp", "tarih"]
RATING_KEYS = ["rating", "score", "stars", "rating_value", "overall", "puan"]
SOURCE_KEYS = ["source_url", "url", "link", "permalink", "source", "page_url"]


def _first_text(record: Dict[str, Any], keys: Iterable[str]) -> Optional[str]:
    for key in keys:
        value = _match_key(record, key)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                return stripped
    return None


def _first_value(record: Dict[str, Any], keys: Iterable[str]) -> Optional[Any]:
    for key in keys:
        value = _match_key(record, key)
        if value not in (None, ""):
            return value
    return None


def _match_key(record: Dict[str, Any], key: str) -> Optional[Any]:
    if key in record:
        return record[key]
    key_cf = key.casefold()
    for actual_key, value in record.items():
        if isinstance(actual_key, str) and actual_key.casefold() == key_cf:
            return value
    return None


def _format_record(record: Dict[str, Any]) -> List[str]:
    item_name = _first_text(record, ITEM_NAME_KEYS) or "Unknown"
    item_id = _first_text(record, ITEM_ID_KEYS) or "-"
    title = _first_text(record, TITLE_KEYS) or "(no title)"
    body = _first_text(record, TEXT_KEYS) or "(no body)"
    author = _first_text(record, AUTHOR_KEYS) or "Unknown"
    date = _first_text(record, DATE_KEYS) or "Unknown"
    rating = _first_value(record, RATING_KEYS) or "Unknown"
    source = _first_text(record, SOURCE_KEYS) or "-"
    lines = [
        f"Item: {item_name} ({item_id})",
        f"Review ID: {record.get('review_id', '-')}",
        f"Author: {author}",
        f"Date: {date}",
        f"Rating: {rating}",
        f"Source: {source}\n",
        f"Title: {title}\n",
        body,
        "\nRaw record:",
        json.dumps(record, indent=2, ensure_ascii=False),
    ]
    return lines


def load_records(dataset_path: Path) -> List[Dict[str, Any]]:
    """Return parsed rows from JSONL or Parquet datasets."""
    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset not found: {dataset_path}")

    suffix = dataset_path.suffix.lower()
    if suffix == ".jsonl":
        return _load_jsonl(dataset_path)
    if suffix in {".parquet", ".pq"}:
        return _load_parquet(dataset_path)
    raise ValueError(
        "Unsupported dataset format. Provide a .jsonl or .parquet file."
    )


def _load_jsonl(dataset_path: Path) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    with dataset_path.open("r", encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"Invalid JSON on line {line_number} of {dataset_path}: {exc}"
                ) from exc
    return records


def _load_parquet(dataset_path: Path) -> List[Dict[str, Any]]:
    if pd is None:
        raise ImportError(
            "pandas (with pyarrow or fastparquet) is required to open Parquet files."
        )
    try:
        frame = pd.read_parquet(dataset_path)
    except Exception as exc:  # pragma: no cover - delegated to pandas
        raise ValueError(f"Failed to read Parquet file {dataset_path}: {exc}") from exc
    return frame.fillna("").to_dict(orient="records")


class DatasetViewer(tk.Tk):
    """Minimal GUI that lists reviews and shows their details."""

    def __init__(self, records: List[Dict[str, Any]], source_path: Path) -> None:
        super().__init__()
        self.records = records
        self.source_path = source_path

        self.title(f"Review Dataset Viewer - {source_path.name}")
        self.geometry("960x600")

        self._build_layout()
        self._populate_list()

    def _build_layout(self) -> None:
        controls = ttk.Frame(self)
        controls.pack(fill=tk.X, padx=10, pady=5)

        open_button = ttk.Button(controls, text="Open dataset...", command=self._prompt_dataset)
        open_button.pack(side=tk.LEFT)

        self.status_label = ttk.Label(controls, text=str(self.source_path))
        self.status_label.pack(side=tk.LEFT, padx=10)

        paned = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        left_frame = ttk.Frame(paned)
        right_frame = ttk.Frame(paned)
        paned.add(left_frame, weight=1)
        paned.add(right_frame, weight=2)

        self.listbox = tk.Listbox(left_frame, exportselection=False)
        self.listbox.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.listbox.bind("<<ListboxSelect>>", self._show_details)

        self.detail_text = tk.Text(right_frame, wrap=tk.WORD, state=tk.DISABLED)
        self.detail_text.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

    def _populate_list(self) -> None:
        self.listbox.delete(0, tk.END)
        for idx, record in enumerate(self.records, start=1):
            title = _first_text(record, TITLE_KEYS) or _first_text(record, TEXT_KEYS) or "(no text)"
            preview = title.strip().split("\n", 1)[0][:80]
            author = _first_text(record, AUTHOR_KEYS) or "Unknown"
            self.listbox.insert(tk.END, f"{idx:03d} | {author}: {preview}")

        if self.records:
            self.listbox.selection_set(0)
            self._show_details()
        else:
            self._update_detail_panel("Dataset has no records.")

    def _show_details(self, _event: Any = None) -> None:
        selection = self.listbox.curselection()
        if not selection:
            return
        record = self.records[selection[0]]
        lines = _format_record(record)
        self._update_detail_panel("\n".join(lines))

    def _update_detail_panel(self, text: str) -> None:
        self.detail_text.configure(state=tk.NORMAL)
        self.detail_text.delete("1.0", tk.END)
        self.detail_text.insert(tk.END, text)
        self.detail_text.configure(state=tk.DISABLED)

    def _prompt_dataset(self) -> None:
        selected = filedialog.askopenfilename(
            title="Choose dataset",
            filetypes=(
                ("Parquet", "*.parquet *.pq"),
                ("JSON Lines", "*.jsonl"),
                ("All files", "*.*"),
            ),
            initialdir=str(self.source_path.parent),
        )
        if not selected:
            return
        new_path = Path(selected)
        try:
            self.records = load_records(new_path)
        except (FileNotFoundError, ValueError) as exc:
            messagebox.showerror("Error", str(exc))
            return

        self.source_path = new_path
        self.status_label.configure(text=str(new_path))
        self.title(f"Review Dataset Viewer - {new_path.name}")
        self._populate_list()


def main() -> None:
    parser = argparse.ArgumentParser(description="Display a review dataset in a GUI window.")
    parser.add_argument(
        "dataset",
        nargs="?",
        type=Path,
        default=(Path(__file__).resolve().parents[1] / "scraper_project" / "data" / "raw" / "sample-espresso-machine.jsonl"),
        help="Path to a JSONL or Parquet dataset (defaults to the sample espresso machine reviews).",
    )
    args = parser.parse_args()

    try:
        records = load_records(args.dataset)
    except (FileNotFoundError, ValueError) as exc:
        raise SystemExit(str(exc))

    app = DatasetViewer(records, args.dataset)
    app.mainloop()


if __name__ == "__main__":
    main()
