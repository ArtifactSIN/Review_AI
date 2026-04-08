"""
Review Scraper Dashboard
========================
Python 3.9+  |  pip install customtkinter
Run: python dashboard.py
"""

import customtkinter as ctk
import tkinter as tk
from tkinter import font as tkfont
import subprocess
import threading
import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime

# ─── CONFIG ────────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent
PRODUCT_IDS_DIR = BASE_DIR / "product_ids"
RAW_DATA_DIR    = BASE_DIR / "raw_data"
LOGS_DIR        = BASE_DIR / "logs"
STATUS_FILE     = LOGS_DIR / "current_status.json"
PKG_FILE        = BASE_DIR / "package.json"

# Team → category assignments (mirrors collection_auto_rawData.js)
TEAM_ASSIGNMENTS = {
    "arda": [
        "kitap", "dekorasyon-ve-aydinlatma", "telefon-ve-aksesuarlari",
        "ses-sistemleri-ve-navigasyon", "motosiklet", "kadin-bakim-urunleri",
        "su-sporlari", "yuz-ve-vucut-bakimi", "cinsel-urunler",
        "beslenme-ve-mama-sandalyesi", "bilgisayar", "bebek-giyim",
        "bireysel-ve-takim-sporlari", "emzirme-urunleri",
        "guzellik-salonu-ve-kuafor-urunleri", "kis-sporlari",
    ],
    "tugce": [
        "kadin-giyim-aksesuar", "outdoor-ve-kamp", "erkek-giyim-aksesuar",
        "evcil-hayvan-urunleri", "yedek-parca-otomobil", "bisiklet-ve-scooter",
        "elektrikli-ev-aletleri", "lastik-ve-jant", "mutfak-gerecleri",
        "spor-giyim-ve-ayakkabi", "avcilik-ve-balikcilik", "erkek-bakim-urunleri",
        "mobilya", "bebek-bezi-ve-islak-mendil", "biberon-ve-aksesuarlari",
        "dugun-davet-organizasyon", "fotograf-ve-kamera",
        "ilginc-akilli-urunler", "tekne-ve-yat-malzemeleri",
    ],
    "havvagul": [
        "parfum-ve-deodorant", "saglik-ve-medikal-urunler", "ev-tekstili",
        "kirtasiye-ve-ofis", "beyaz-esya", "yetiskin-hobi-ve-oyun", "muzik",
        "sac-bakim-ve-sekillendirme", "bebek-odasi-ve-park-yatak", "makyaj",
        "cocuk-oyuncaklari-ve-parti", "fitness-ve-kondisyon",
        "yapi-market-ve-bahce", "bebek-guvenlik", "dijital-kodlar-urunler",
        "film", "hamile-giyim", "oto-koltugu-ve-ana-kucagi",
        "yurutec-ve-yurume-yardimcilari", "yasam-ve-etkinlik",
    ],
}

TEAM_COLORS = {
    "arda":     "#4C8EDA",
    "tugce":    "#5DC07A",
    "havvagul": "#E8855A",
}

REFRESH_INTERVAL_MS = 2500   # how often the stats auto-refresh (ms)

# ─── HELPERS ───────────────────────────────────────────────────────────────────

def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def get_product_ids(slug: str) -> list:
    p = PRODUCT_IDS_DIR / f"{slug}_ids.json"
    if not p.exists():
        return []
    data = read_json(p)
    if data is None:
        return []
    if isinstance(data, dict):
        ids = data.get("ids", [])
    elif isinstance(data, list):
        ids = data
    else:
        return []
    return [str(i).strip() for i in ids if str(i).strip()]


def get_collected_count(slug: str) -> int:
    cat_dir = RAW_DATA_DIR / slug
    if not cat_dir.is_dir():
        return 0
    return sum(1 for f in cat_dir.iterdir() if f.suffix == ".json" and "partial" not in f.name)


def compute_stats():
    """
    Returns:
        per_team  : {team: {total, done, reviews}}
        overall   : {total, done, reviews}
        per_category: {slug: {total, done, team}}
    """
    per_team = {t: {"total": 0, "done": 0, "reviews": 0} for t in TEAM_ASSIGNMENTS}
    overall  = {"total": 0, "done": 0, "reviews": 0}
    per_category = {}

    all_assigned = set()
    for team, cats in TEAM_ASSIGNMENTS.items():
        for slug in cats:
            all_assigned.add(slug)
            ids    = get_product_ids(slug)
            done   = get_collected_count(slug)
            total  = len(ids)

            # count reviews inside collected files
            rev_count = 0
            cat_dir = RAW_DATA_DIR / slug
            if cat_dir.is_dir():
                for fp in cat_dir.iterdir():
                    if fp.suffix == ".json" and "partial" not in fp.name:
                        d = read_json(fp)
                        if isinstance(d, dict):
                            rev_count += d.get("reviewCountUnique", len(d.get("reviews", [])))

            per_team[team]["total"]   += total
            per_team[team]["done"]    += done
            per_team[team]["reviews"] += rev_count
            overall["total"]   += total
            overall["done"]    += done
            overall["reviews"] += rev_count

            per_category[slug] = {"total": total, "done": done, "reviews": rev_count, "team": team}

    return per_team, overall, per_category


def get_npm_scripts() -> dict:
    """Returns {script_name: command_string} from package.json"""
    data = read_json(PKG_FILE)
    if data and "scripts" in data:
        return data["scripts"]
    return {}


def ts_now():
    return datetime.now().strftime("%H:%M:%S")


# ─── APP ───────────────────────────────────────────────────────────────────────

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")


class Dashboard(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Review Scraper Dashboard")
        self.geometry("1200x800")
        self.minsize(900, 620)

        self._running_proc: subprocess.Popen | None = None
        self._stop_event = threading.Event()

        self._build_ui()
        self._refresh_stats()
        self._schedule_refresh()

    # ── UI CONSTRUCTION ──────────────────────────────────────────────────────

    def _build_ui(self):
        # Top nav bar
        nav = ctk.CTkFrame(self, height=50, corner_radius=0, fg_color="#1a1a2e")
        nav.pack(fill="x", side="top")
        ctk.CTkLabel(nav, text="🔍  Review Scraper Dashboard",
                     font=ctk.CTkFont(size=16, weight="bold"),
                     text_color="#a0c4ff").pack(side="left", padx=18, pady=10)

        self._status_label = ctk.CTkLabel(nav, text="● Idle",
                                          font=ctk.CTkFont(size=12),
                                          text_color="#888")
        self._status_label.pack(side="right", padx=18)

        # Main paned layout: left = stats, right = runner
        pane = tk.PanedWindow(self, orient=tk.HORIZONTAL, bg="#2b2b2b",
                              sashwidth=6, sashrelief=tk.FLAT)
        pane.pack(fill="both", expand=True, padx=0, pady=0)

        # ── LEFT: Stats panel ──────────────────────────────────────────────
        left_frame = ctk.CTkFrame(pane, corner_radius=0)
        pane.add(left_frame, minsize=340)

        ctk.CTkLabel(left_frame, text="Progress", font=ctk.CTkFont(size=14, weight="bold")).pack(
            anchor="w", padx=16, pady=(14, 4))

        # Overall card
        self._overall_card = self._make_progress_card(
            left_frame, "Overall", "#7B68EE", 0, 0, 0)
        self._overall_card["frame"].pack(fill="x", padx=12, pady=(0, 10))

        # Team cards
        self._team_cards = {}
        for team, color in TEAM_COLORS.items():
            card = self._make_progress_card(left_frame, team.capitalize(), color, 0, 0, 0)
            card["frame"].pack(fill="x", padx=12, pady=(0, 8))
            self._team_cards[team] = card

        # Category breakdown toggle
        self._cat_visible = False
        toggle_btn = ctk.CTkButton(left_frame, text="▶  Category Details",
                                   fg_color="transparent", hover_color="#333355",
                                   anchor="w", command=self._toggle_categories)
        toggle_btn.pack(fill="x", padx=12, pady=(4, 0))
        self._cat_toggle_btn = toggle_btn

        self._cat_scroll = ctk.CTkScrollableFrame(left_frame, label_text="",
                                                   corner_radius=8, height=0)
        # category rows added dynamically
        self._cat_rows: dict[str, dict] = {}

        # Refresh button
        ctk.CTkButton(left_frame, text="↻  Refresh Now", height=32,
                      command=self._refresh_stats).pack(fill="x", padx=12, pady=(10, 12))

        # ── RIGHT: Script runner panel ─────────────────────────────────────
        right_frame = ctk.CTkFrame(pane, corner_radius=0)
        pane.add(right_frame, minsize=480)

        # Script selector header
        hdr = ctk.CTkFrame(right_frame, fg_color="transparent")
        hdr.pack(fill="x", padx=14, pady=(14, 4))
        ctk.CTkLabel(hdr, text="Run Script", font=ctk.CTkFont(size=14, weight="bold")).pack(side="left")

        self._script_var = ctk.StringVar()
        scripts = get_npm_scripts()
        script_names = list(scripts.keys())
        default = script_names[0] if script_names else ""
        self._script_var.set(default)
        self._scripts_map = scripts

        selector_row = ctk.CTkFrame(right_frame, fg_color="transparent")
        selector_row.pack(fill="x", padx=14, pady=(0, 4))

        self._script_menu = ctk.CTkOptionMenu(
            selector_row, variable=self._script_var,
            values=script_names, width=260,
            command=self._on_script_selected,
            dynamic_resizing=False)
        self._script_menu.pack(side="left", padx=(0, 8))

        self._run_btn = ctk.CTkButton(selector_row, text="▶  Run", width=80,
                                      fg_color="#2e7d32", hover_color="#1b5e20",
                                      command=self._run_script)
        self._run_btn.pack(side="left", padx=(0, 6))

        self._stop_btn = ctk.CTkButton(selector_row, text="■  Stop", width=80,
                                       fg_color="#b71c1c", hover_color="#7f0000",
                                       state="disabled", command=self._stop_script)
        self._stop_btn.pack(side="left", padx=(0, 6))

        self._customize_btn = ctk.CTkButton(
            selector_row, text="⚙  Customize", width=100,
            fg_color="#2a2a3e", hover_color="#3a3a5e",
            border_width=1, border_color="#555",
            command=self._toggle_customize)
        self._customize_btn.pack(side="left")

        # ── Customize panel (hidden by default) ───────────────────────────
        self._customize_visible = False
        self._customize_panel = ctk.CTkFrame(
            right_frame, corner_radius=8,
            fg_color="#1a1a2e", border_width=1, border_color="#3a3a5e")
        # Not packed yet — shown on toggle

        cust_inner = ctk.CTkFrame(self._customize_panel, fg_color="transparent")
        cust_inner.pack(fill="x", padx=12, pady=10)

        # Row 1: label + entry
        row1 = ctk.CTkFrame(cust_inner, fg_color="transparent")
        row1.pack(fill="x", pady=(0, 6))
        ctk.CTkLabel(row1, text="Extra flags:",
                     font=ctk.CTkFont(size=12), width=80, anchor="w").pack(side="left")
        self._extra_args_var = ctk.StringVar()
        self._extra_args_entry = ctk.CTkEntry(
            row1, textvariable=self._extra_args_var,
            placeholder_text="e.g.  --categories=kitap  --concurrency=5",
            font=ctk.CTkFont(family="Courier", size=11),
            height=30)
        self._extra_args_entry.pack(side="left", fill="x", expand=True, padx=(6, 6))
        ctk.CTkButton(row1, text="✕", width=30, height=30,
                      fg_color="#333", hover_color="#555",
                      command=lambda: self._extra_args_var.set("")).pack(side="left")

        # Row 2: quick-pick preset chips
        row2 = ctk.CTkFrame(cust_inner, fg_color="transparent")
        row2.pack(fill="x", pady=(0, 6))
        ctk.CTkLabel(row2, text="Quick add:",
                     font=ctk.CTkFont(size=11), text_color="#888",
                     width=80, anchor="w").pack(side="left")

        presets = [
            ("concurrency=3",  "--concurrency=3"),
            ("concurrency=5",  "--concurrency=5"),
            ("concurrency=10", "--concurrency=10"),
            ("failed-only",    "--failed-only"),
            ("list-runs",      "--list-runs"),
        ]
        for label, flag in presets:
            ctk.CTkButton(
                row2, text=label, width=0, height=24,
                font=ctk.CTkFont(size=10),
                fg_color="#2a3a2a", hover_color="#3a4e3a",
                border_width=1, border_color="#3d5c3d",
                command=lambda f=flag: self._append_preset(f)
            ).pack(side="left", padx=(0, 4))

        # Row 3: live final-command preview
        self._final_cmd_label = ctk.CTkLabel(
            cust_inner, text="",
            font=ctk.CTkFont(family="Courier", size=10),
            text_color="#7a9cbf", anchor="w", wraplength=580)
        self._final_cmd_label.pack(fill="x", pady=(2, 0))

        # Wire up live preview updates
        self._extra_args_var.trace_add("write", lambda *_: self._update_cmd_preview())

        # Command preview (base, shown below customize panel)
        self._cmd_label = ctk.CTkLabel(right_frame,
                                       text=f"npm run {default}",
                                       font=ctk.CTkFont(family="Courier", size=11),
                                       text_color="#aaa", anchor="w")
        self._cmd_label.pack(fill="x", padx=16, pady=(0, 6))

        # Console output
        ctk.CTkLabel(right_frame, text="Console Output",
                     font=ctk.CTkFont(size=13, weight="bold")).pack(
            anchor="w", padx=14, pady=(0, 4))

        console_wrap = ctk.CTkFrame(right_frame, fg_color="#0d0d0d", corner_radius=8)
        console_wrap.pack(fill="both", expand=True, padx=12, pady=(0, 4))

        self._console = tk.Text(
            console_wrap,
            bg="#0d0d0d", fg="#cccccc",
            insertbackground="#cccccc",
            selectbackground="#333",
            font=("Courier", 11),
            wrap="word",
            relief="flat",
            state="disabled",
            padx=10, pady=8,
        )
        self._console.pack(fill="both", expand=True, side="left")

        scroll = ctk.CTkScrollbar(console_wrap, command=self._console.yview)
        scroll.pack(fill="y", side="right")
        self._console.configure(yscrollcommand=scroll.set)

        # Tag colours for different line types
        self._console.tag_config("error",   foreground="#ff6b6b")
        self._console.tag_config("warn",    foreground="#ffd93d")
        self._console.tag_config("info",    foreground="#6bcb77")
        self._console.tag_config("skip",    foreground="#888888")
        self._console.tag_config("saved",   foreground="#4dabf7")
        self._console.tag_config("header",  foreground="#a29bfe")
        self._console.tag_config("normal",  foreground="#cccccc")

        # Console toolbar
        bar = ctk.CTkFrame(right_frame, fg_color="transparent")
        bar.pack(fill="x", padx=12, pady=(0, 10))
        ctk.CTkButton(bar, text="Clear", width=70, height=26,
                      fg_color="#333", hover_color="#444",
                      command=self._clear_console).pack(side="left")
        self._line_count_label = ctk.CTkLabel(bar, text="0 lines",
                                              font=ctk.CTkFont(size=11),
                                              text_color="#666")
        self._line_count_label.pack(side="right")

        # Final layout weight
        pane.paneconfigure(left_frame,  minsize=340)
        pane.paneconfigure(right_frame, minsize=480)

    # ── PROGRESS CARDS ───────────────────────────────────────────────────────

    def _make_progress_card(self, parent, name, color, done, total, reviews):
        frame = ctk.CTkFrame(parent, corner_radius=10)

        header = ctk.CTkFrame(frame, fg_color="transparent")
        header.pack(fill="x", padx=12, pady=(8, 2))

        dot = ctk.CTkLabel(header, text="●", text_color=color,
                           font=ctk.CTkFont(size=14))
        dot.pack(side="left")

        lbl = ctk.CTkLabel(header, text=f"  {name}",
                           font=ctk.CTkFont(size=13, weight="bold"))
        lbl.pack(side="left")

        pct_val = (done / total * 100) if total else 0
        pct_lbl = ctk.CTkLabel(header,
                               text=f"{pct_val:.1f}%",
                               font=ctk.CTkFont(size=13, weight="bold"),
                               text_color=color)
        pct_lbl.pack(side="right")

        bar = ctk.CTkProgressBar(frame, height=10, progress_color=color,
                                  fg_color="#2a2a2a")
        bar.set(pct_val / 100)
        bar.pack(fill="x", padx=12, pady=(2, 4))

        sub = ctk.CTkLabel(frame,
                           text=f"{done:,} / {total:,} products   ·   {reviews:,} reviews",
                           font=ctk.CTkFont(size=11), text_color="#999")
        sub.pack(anchor="w", padx=12, pady=(0, 8))

        return {"frame": frame, "bar": bar, "pct": pct_lbl, "sub": sub}

    def _update_card(self, card, done, total, reviews):
        pct = (done / total * 100) if total else 0
        card["bar"].set(pct / 100)
        card["pct"].configure(text=f"{pct:.1f}%")
        card["sub"].configure(
            text=f"{done:,} / {total:,} products   ·   {reviews:,} reviews")

    # ── STATS REFRESH ────────────────────────────────────────────────────────

    def _refresh_stats(self):
        threading.Thread(target=self._fetch_and_update_stats, daemon=True).start()

    def _fetch_and_update_stats(self):
        per_team, overall, per_category = compute_stats()
        self.after(0, lambda: self._apply_stats(per_team, overall, per_category))

    def _apply_stats(self, per_team, overall, per_category):
        self._update_card(self._overall_card,
                          overall["done"], overall["total"], overall["reviews"])
        for team, card in self._team_cards.items():
            s = per_team[team]
            self._update_card(card, s["done"], s["total"], s["reviews"])

        # rebuild category rows if visible
        if self._cat_visible:
            self._populate_category_rows(per_category)

    def _schedule_refresh(self):
        self._refresh_stats()
        self.after(REFRESH_INTERVAL_MS, self._schedule_refresh)

    # ── CATEGORY PANEL ───────────────────────────────────────────────────────

    def _toggle_categories(self):
        if self._cat_visible:
            self._cat_scroll.pack_forget()
            self._cat_toggle_btn.configure(text="▶  Category Details")
            self._cat_visible = False
        else:
            _, _, per_category = compute_stats()
            self._populate_category_rows(per_category)
            self._cat_scroll.pack(fill="both", expand=True, padx=12, pady=(0, 4))
            self._cat_toggle_btn.configure(text="▼  Category Details")
            self._cat_visible = True

    def _populate_category_rows(self, per_category):
        # Clear old rows
        for w in self._cat_scroll.winfo_children():
            w.destroy()
        self._cat_rows = {}

        for slug, info in sorted(per_category.items()):
            color = TEAM_COLORS.get(info["team"], "#888")
            row = ctk.CTkFrame(self._cat_scroll, fg_color="transparent")
            row.pack(fill="x", pady=1)

            # Team dot
            ctk.CTkLabel(row, text="●", text_color=color,
                         width=14, font=ctk.CTkFont(size=10)).pack(side="left")

            # Slug label
            ctk.CTkLabel(row, text=slug, font=ctk.CTkFont(size=11),
                         width=240, anchor="w").pack(side="left", padx=(4, 8))

            total = info["total"]
            done  = info["done"]
            pct   = (done / total * 100) if total else 0.0

            bar = ctk.CTkProgressBar(row, width=120, height=7,
                                     progress_color=color, fg_color="#333")
            bar.set(pct / 100)
            bar.pack(side="left", padx=(0, 6))

            ctk.CTkLabel(row,
                         text=f"{done}/{total}  ({pct:.0f}%)",
                         font=ctk.CTkFont(size=10), text_color="#aaa",
                         width=100, anchor="w").pack(side="left")

    # ── CUSTOMIZE PANEL ──────────────────────────────────────────────────────

    def _toggle_customize(self):
        if self._customize_visible:
            self._customize_panel.pack_forget()
            self._customize_btn.configure(
                text="⚙  Customize", fg_color="#2a2a3e", border_color="#555")
            self._customize_visible = False
        else:
            # Insert panel just above the cmd_label
            self._customize_panel.pack(fill="x", padx=12, pady=(0, 6),
                                       before=self._cmd_label)
            self._customize_btn.configure(
                text="⚙  Customize ▲", fg_color="#1e2e4e", border_color="#4a6a9e")
            self._customize_visible = True
            self._update_cmd_preview()

    def _append_preset(self, flag: str):
        current = self._extra_args_var.get().strip()
        # Avoid duplicating the same flag
        if flag not in current:
            new_val = (current + "  " + flag).strip() if current else flag
            self._extra_args_var.set(new_val)
        self._extra_args_entry.focus()

    def _update_cmd_preview(self):
        name   = self._script_var.get()
        base   = self._scripts_map.get(name, "")
        extras = self._extra_args_var.get().strip()
        # Build what will actually execute
        if extras:
            final = f"{base}  {extras}"
        else:
            final = base
        self._final_cmd_label.configure(text=f"→  {final}")
        # Also update the simple label below
        self._cmd_label.configure(
            text=f"npm run {name}" + (f"  +  {extras}" if extras else ""))

    # ── SCRIPT RUNNER ────────────────────────────────────────────────────────

    def _on_script_selected(self, value):
        cmd = self._scripts_map.get(value, "")
        extras = self._extra_args_var.get().strip() if hasattr(self, "_extra_args_var") else ""
        self._cmd_label.configure(
            text=f"npm run {value}   →   {cmd}" + (f"  +  {extras}" if extras else ""))
        self._update_cmd_preview()

    def _build_exec_cmd(self, script_name: str) -> list[str]:
        """
        Build the actual command list to execute.
        If extra args are set, we run the underlying node command directly
        (avoids npm's `--` separator quoting issues on Windows/macOS).
        """
        extras = self._extra_args_var.get().strip()
        base_cmd = self._scripts_map.get(script_name, "")

        if not extras:
            return ["npm", "run", script_name]

        # Parse the base npm script command and append extra tokens
        import shlex
        try:
            base_tokens = shlex.split(base_cmd)
        except ValueError:
            base_tokens = base_cmd.split()

        try:
            extra_tokens = shlex.split(extras)
        except ValueError:
            extra_tokens = extras.split()

        return base_tokens + extra_tokens

    def _run_script(self):
        if self._running_proc is not None:
            return

        name = self._script_var.get()
        if not name:
            return

        self._run_btn.configure(state="disabled")
        self._stop_btn.configure(state="normal")
        self._set_status(f"● Running: {name}", "#4dabf7")
        self._stop_event.clear()

        extras = self._extra_args_var.get().strip()
        header_line = f"[{ts_now()}] ▶  npm run {name}"
        if extras:
            header_line += f"  +  {extras}"
        self._console_writeln(header_line + "\n", tag="header")

        cmd = self._build_exec_cmd(name)
        self._console_writeln(f"           cmd: {' '.join(cmd)}\n", tag="skip")

        thread = threading.Thread(
            target=self._run_npm_script, args=(name, cmd), daemon=True)
        thread.start()

    def _run_npm_script(self, script_name, cmd: list[str]):
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(BASE_DIR),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            self._running_proc = proc

            for line in proc.stdout:
                if self._stop_event.is_set():
                    proc.terminate()
                    break
                self.after(0, lambda l=line: self._console_writeln(l))

            proc.wait()
            rc = proc.returncode

            msg = f"\n[{ts_now()}] ● Process exited (code {rc})\n"
            tag = "info" if rc == 0 else "error"
            self.after(0, lambda m=msg, t=tag: self._console_writeln(m, tag=t))
        except FileNotFoundError:
            self.after(0, lambda: self._console_writeln(
                "[ERROR] npm / node not found. Make sure Node.js is on PATH.\n", tag="error"))
        except Exception as e:
            self.after(0, lambda err=e: self._console_writeln(f"[ERROR] {err}\n", tag="error"))
        finally:
            self._running_proc = None
            self.after(0, self._on_script_finished)
            # Trigger stats refresh once done
            self.after(800, self._refresh_stats)

    def _stop_script(self):
        self._stop_event.set()
        if self._running_proc:
            try:
                self._running_proc.terminate()
            except Exception:
                pass
        self._console_writeln(f"\n[{ts_now()}] ■  Stop requested.\n", tag="warn")

    def _on_script_finished(self):
        self._run_btn.configure(state="normal")
        self._stop_btn.configure(state="disabled")
        self._set_status("● Idle", "#888")

    # ── CONSOLE ──────────────────────────────────────────────────────────────

    def _console_writeln(self, text: str, tag: str | None = None):
        """Write a line to the console widget with auto-coloring."""
        if tag is None:
            tag = self._auto_tag(text)

        self._console.configure(state="normal")
        self._console.insert("end", text, tag)
        self._console.see("end")
        self._console.configure(state="disabled")

        # Update line count
        count = int(self._console.index("end-1c").split(".")[0])
        self._line_count_label.configure(text=f"{count:,} lines")

    def _auto_tag(self, text: str) -> str:
        t = text.lower()
        if "error" in t or "fatal" in t or "fail" in t:
            return "error"
        if "warn" in t:
            return "warn"
        if "[review saved]" in t or "saved" in t:
            return "saved"
        if "skip" in t:
            return "skip"
        if t.startswith("[run]") or t.startswith("[team") or t.startswith("[reviews]"):
            return "header"
        if "finished" in t or "completed" in t or "done" in t:
            return "info"
        return "normal"

    def _clear_console(self):
        self._console.configure(state="normal")
        self._console.delete("1.0", "end")
        self._console.configure(state="disabled")
        self._line_count_label.configure(text="0 lines")

    # ── MISC ─────────────────────────────────────────────────────────────────

    def _set_status(self, text: str, color: str = "#888"):
        self._status_label.configure(text=text, text_color=color)


# ─── ENTRY ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = Dashboard()
    app.mainloop()
