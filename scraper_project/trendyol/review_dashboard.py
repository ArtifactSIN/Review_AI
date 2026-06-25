#!/usr/bin/env python3
"""
Trendyol Review Dashboard
Usage: python review_dashboard.py
"""

import customtkinter as ctk
import tkinter as tk
import subprocess
import threading
import json
import time
from pathlib import Path
from datetime import datetime

# ─── PATHS ────────────────────────────────────────────────────────────────────

SCRIPT_DIR  = Path(__file__).parent
REPO_ROOT   = SCRIPT_DIR.parent
NODE_SCRIPT = SCRIPT_DIR / "collection_auto_rawData.js"
LOGS_DIR    = SCRIPT_DIR / "logs"
META_FILE   = LOGS_DIR / "shared_meta.json"

GIT_SYNC_FILES = [
    "trendyol/logs/shared_meta.json",
    "logs/gid_counter.json",
]
GIT_SYNC_INTERVAL  = 300    # seconds
REFRESH_INTERVAL   = 3000   # ms
MAX_CONSOLE_LINES  = 2000
CONSOLE_TRIM_TO    = 1500

# ─── THEMES ──────────────────────────────────────────────────────────────────

THEMES = {
    "arda": {
        "mode":      "dark",
        "label":     "Arda",
        "nav_bg":    "#0a1628",
        "main_bg":   "#0d1b2a",
        "card_bg":   "#12263a",
        "accent":    "#1e3a5f",
        "highlight": "#4a7cbf",
        "dot":       "#4a7cbf",
        "btn_run":   "#1a4a7a",
        "btn_run_h": "#0d3060",
        "btn_stop":  "#7a1a1a",
        "btn_stop_h":"#5a0f0f",
        "tag_color": "#a0c4ff",
        "subtext":   "#6a8fb0",
    },
    "tugce": {
        "mode":      "light",
        "label":     "Tugçe",
        "nav_bg":    "#ede9f8",
        "main_bg":   "#f7f5ff",
        "card_bg":   "#eee9fb",
        "accent":    "#d8d0f5",
        "highlight": "#7c5cbf",
        "dot":       "#9d7fd4",
        "btn_run":   "#6d48b8",
        "btn_run_h": "#5a3a9e",
        "btn_stop":  "#b84040",
        "btn_stop_h":"#963030",
        "tag_color": "#5a3a9e",
        "subtext":   "#7060a0",
    },
    "havvagul": {
        "mode":      "light",
        "label":     "Havvagül",
        "nav_bg":    "#bde0f8",
        "main_bg":   "#eaf6ff",
        "card_bg":   "#d8eeff",
        "accent":    "#90cdf4",
        "highlight": "#3a90cc",
        "dot":       "#4299e1",
        "btn_run":   "#2a7abb",
        "btn_run_h": "#1a5e94",
        "btn_stop":  "#b84040",
        "btn_stop_h":"#963030",
        "tag_color": "#1a5e94",
        "subtext":   "#3a6080",
    },
}

TEAM_COLORS = {
    "arda":     "#4a7cbf",
    "tugce":    "#e8758a",
    "havvagul": "#4299e1",
}

OVERALL_COLOR     = "#9b8aee"
TIME_LIMIT_STEPS  = [0, 30, 60, 120, 240, 480]
TIME_LIMIT_LABELS = ["No limit", "30 min", "1 hr", "2 hr", "4 hr", "8 hr"]

# ─── HELPERS ─────────────────────────────────────────────────────────────────

def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def ts_now():
    return datetime.now().strftime("%H:%M:%S")

def fmt(n):
    if n is None: return "?"
    n = int(n)
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000:     return f"{n/1_000:.1f}K"
    return f"{n:,}"

# ─── STEAM-STYLE USER CARD ───────────────────────────────────────────────────

class UserCard(ctk.CTkFrame):
    BASE  = "#161f2e"
    HOVER = "#1e2d42"

    def __init__(self, parent, key, initial, name, circle_color, hint, on_click):
        super().__init__(parent, width=200, height=280,
                         corner_radius=18, fg_color=self.BASE, cursor="hand2")
        self.pack_propagate(False)
        self._on_click = lambda: on_click(key)

        canvas = tk.Canvas(self, width=90, height=90,
                           bg=self.BASE, highlightthickness=0)
        canvas.pack(pady=(32, 10))
        canvas.create_oval(5, 5, 85, 85, fill=circle_color, outline="")
        canvas.create_text(45, 45, text=initial,
                           font=("Helvetica", 30, "bold"), fill="white")

        ctk.CTkLabel(self, text=name,
                     font=ctk.CTkFont(size=17, weight="bold"),
                     text_color="#e8edf4").pack()
        ctk.CTkLabel(self, text=hint,
                     font=ctk.CTkFont(size=12),
                     text_color="#4a5a6e").pack(pady=(5, 14))

        self._bind_recursive(self)

    def _bind_recursive(self, widget):
        widget.bind("<Enter>",    self._on_enter)
        widget.bind("<Leave>",    self._on_leave)
        widget.bind("<Button-1>", lambda e: self._on_click())
        for child in widget.winfo_children():
            self._bind_recursive(child)

    def _on_enter(self, _e):
        self.configure(fg_color=self.HOVER)

    def _on_leave(self, e):
        under = self.winfo_containing(e.x_root, e.y_root)
        if under is None or not str(under).startswith(str(self)):
            self.configure(fg_color=self.BASE)

# ─── PROGRESS CARD ───────────────────────────────────────────────────────────

def make_card(parent, name, color, done=0, total=0, reviews=0, card_bg="#1e2a3a", bar_track="#2a2a3a"):
    frame = ctk.CTkFrame(parent, corner_radius=16, fg_color=card_bg)

    hdr = ctk.CTkFrame(frame, fg_color="transparent")
    hdr.pack(fill="x", padx=18, pady=(12, 3))

    ctk.CTkLabel(hdr, text="●", text_color=color,
                 font=ctk.CTkFont(size=14)).pack(side="left")
    ctk.CTkLabel(hdr, text=f"  {name}",
                 font=ctk.CTkFont(size=13, weight="bold")).pack(side="left")

    pct_val = (done / total * 100) if total else 0.0
    pct_lbl = ctk.CTkLabel(hdr, text=f"{pct_val:.1f}%",
                            font=ctk.CTkFont(size=13, weight="bold"),
                            text_color=color)
    pct_lbl.pack(side="right")

    bar = ctk.CTkProgressBar(frame, height=10, progress_color=color, fg_color=bar_track)
    bar.set(pct_val / 100)
    bar.pack(fill="x", padx=18, pady=(3, 5))

    sub = ctk.CTkLabel(frame,
                       text=f"{fmt(done)} / {fmt(total)} products   ·   {fmt(reviews)} reviews",
                       font=ctk.CTkFont(size=11), text_color="#888")
    sub.pack(anchor="w", padx=18, pady=(0, 12))

    return {"frame": frame, "bar": bar, "pct": pct_lbl, "sub": sub}


def update_card(card, done, total, reviews):
    pct = (done / total * 100) if total else 0.0
    card["bar"].set(pct / 100)
    card["pct"].configure(text=f"{pct:.1f}%")
    card["sub"].configure(text=f"{fmt(done)} / {fmt(total)} products   ·   {fmt(reviews)} reviews")


# ─── APP ─────────────────────────────────────────────────────────────────────

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")
        self.title("Trendyol Review Dashboard")
        self.geometry("900x520")
        self.resizable(False, False)
        self.configure(fg_color="#0f1420")

        self._user:  str  = ""
        self._theme: dict = {}
        self._running_proc: subprocess.Popen | None = None
        self._stop_event      = threading.Event()
        self._sync_lock       = threading.Lock()
        self._last_sync_ts: str | None = None
        self._concurrency_val = 3
        self._time_limit_idx  = 0
        self._refresh_after_id = None
        self._cat_rows: dict  = {}

        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._build_select_screen()

    # ─── CLEAN SHUTDOWN ───────────────────────────────────────────────────────

    def _on_close(self):
        self._stop_event.set()
        if self._refresh_after_id:
            self.after_cancel(self._refresh_after_id)
        if self._running_proc:
            try: self._running_proc.terminate()
            except Exception: pass
        self.destroy()

    # ─── SELECT SCREEN ────────────────────────────────────────────────────────

    def _build_select_screen(self):
        ctk.CTkLabel(self, text="Trendyol Review Dashboard",
                     font=ctk.CTkFont(size=22, weight="bold"),
                     text_color="#a0c8f0").pack(pady=(50, 6))
        ctk.CTkLabel(self, text="Select your profile to continue",
                     font=ctk.CTkFont(size=13), text_color="#3a4a5e").pack(pady=(0, 36))

        row = ctk.CTkFrame(self, fg_color="transparent")
        row.pack()

        USERS = [
            ("arda",     "A",  "Arda",     "#2a5298", "Dark · Navy"),
            ("tugce",    "T",  "Tugçe",    "#e8758a", "Soft Pink · Yellow"),
            ("havvagul", "HG", "Havvagül", "#3a90cc", "Sky Blue"),
        ]
        for key, initial, name, circle_color, hint in USERS:
            UserCard(row, key=key, initial=initial, name=name,
                     circle_color=circle_color, hint=hint,
                     on_click=self._select_user).pack(side="left", padx=20)

    def _select_user(self, user_key: str):
        theme = THEMES[user_key]
        ctk.set_appearance_mode(theme["mode"])
        self._user  = user_key
        self._theme = theme

        for w in self.winfo_children():
            w.destroy()

        self.geometry("1280x820")
        self.minsize(1000, 680)
        self.resizable(True, True)
        self.configure(fg_color=theme["main_bg"])
        self.title(f"Trendyol Review Dashboard  ·  {theme['label']}")

        self._cat_rows = {}
        self._build_dashboard()
        self._refresh_stats()
        self._start_auto_refresh()
        self._start_git_sync_thread()

    # ─── DASHBOARD BUILD ──────────────────────────────────────────────────────

    def _build_dashboard(self):
        self._build_nav()

        pane = tk.PanedWindow(self, orient=tk.HORIZONTAL,
                              bg=self._theme["main_bg"], sashwidth=5, sashrelief=tk.FLAT)
        pane.pack(fill="both", expand=True)

        left  = ctk.CTkFrame(pane, corner_radius=0, fg_color=self._theme["main_bg"])
        right = ctk.CTkFrame(pane, corner_radius=0, fg_color=self._theme["main_bg"])
        pane.add(left,  minsize=370)
        pane.add(right, minsize=530)

        self._build_stats_panel(left)
        self._build_runner_panel(right)
        self._build_bottom_bar()

    def _build_nav(self):
        t = self._theme
        nav = ctk.CTkFrame(self, height=58, corner_radius=0, fg_color=t["nav_bg"])
        nav.pack(fill="x", side="top")

        ctk.CTkLabel(nav, text="●", text_color=t["highlight"],
                     font=ctk.CTkFont(size=17)).pack(side="left", padx=(18, 4), pady=16)
        ctk.CTkLabel(nav, text=f"Trendyol Reviews  ·  {t['label']}",
                     font=ctk.CTkFont(size=16, weight="bold"),
                     text_color=t["tag_color"]).pack(side="left", pady=16)

        self._status_lbl = ctk.CTkLabel(nav, text="● Idle",
                                        font=ctk.CTkFont(size=12), text_color="#888")
        self._status_lbl.pack(side="right", padx=16)

        self._sync_lbl = ctk.CTkLabel(nav, text="git: –",
                                      font=ctk.CTkFont(size=11), text_color="#556677")
        self._sync_lbl.pack(side="right", padx=(0, 16))

    # ─── STATS PANEL ──────────────────────────────────────────────────────────

    def _build_stats_panel(self, parent):
        t = self._theme

        ctk.CTkLabel(parent, text="Progress",
                     font=ctk.CTkFont(size=14, weight="bold")).pack(
            anchor="w", padx=16, pady=(14, 4))

        self._overall_card = make_card(parent, "Overall", OVERALL_COLOR, card_bg=t["card_bg"])
        self._overall_card["frame"].pack(fill="x", padx=12, pady=(0, 8))

        self._team_cards: dict = {}
        for team, color in TEAM_COLORS.items():
            card = make_card(parent, team.capitalize(), color, card_bg=t["card_bg"])
            card["frame"].pack(fill="x", padx=12, pady=(0, 5))
            self._team_cards[team] = card

        ctk.CTkFrame(parent, height=1, fg_color=t["accent"]).pack(fill="x", padx=12, pady=(10, 6))

        hdr = ctk.CTkFrame(parent, fg_color="transparent")
        hdr.pack(fill="x", padx=12)
        ctk.CTkLabel(hdr, text=f"My Categories  ({t['label']})",
                     font=ctk.CTkFont(size=12, weight="bold")).pack(side="left")
        self._cat_count_lbl = ctk.CTkLabel(hdr, text="",
                                           font=ctk.CTkFont(size=10), text_color="#888")
        self._cat_count_lbl.pack(side="right")

        self._cat_scroll = ctk.CTkScrollableFrame(parent, corner_radius=12, fg_color=t["card_bg"])
        self._cat_scroll.pack(fill="both", expand=True, padx=12, pady=(4, 4))

        ctk.CTkButton(parent, text="↻  Refresh", height=30,
                      fg_color=t["accent"], hover_color=t["highlight"],
                      command=self._refresh_stats).pack(fill="x", padx=12, pady=(4, 12))

    # ─── CATEGORY ROWS (in-place update) ─────────────────────────────────────

    def _make_cat_row(self, slug: str, info: dict) -> dict:
        color  = TEAM_COLORS.get(self._user, "#888")
        total  = info.get("productCount", 0)
        done   = info.get("done", 0)
        failed = info.get("failed", 0)
        pct    = done / total if total else 0.0

        row = ctk.CTkFrame(self._cat_scroll, fg_color="transparent", height=30)
        row.pack(fill="x", padx=6, pady=1)

        ctk.CTkLabel(row, text="●", text_color=color,
                     width=12, font=ctk.CTkFont(size=10)).pack(side="left")

        display = slug[:26] + "…" if len(slug) > 27 else slug
        ctk.CTkLabel(row, text=display, font=ctk.CTkFont(size=11),
                     width=200, anchor="w").pack(side="left", padx=(3, 5))

        bar = ctk.CTkProgressBar(row, width=96, height=7,
                                 progress_color=color, fg_color="#333")
        bar.set(pct)
        bar.pack(side="left", padx=(0, 4))

        count_lbl = ctk.CTkLabel(row, text=f"{fmt(done)}/{fmt(total)}",
                                 font=ctk.CTkFont(size=10), text_color="#999",
                                 width=72, anchor="w")
        count_lbl.pack(side="left")

        fail_lbl = None
        if failed > 0:
            fail_lbl = ctk.CTkLabel(row, text=f"⚠{failed}",
                                    font=ctk.CTkFont(size=10, weight="bold"),
                                    text_color="#ff6b6b", width=34)
            fail_lbl.pack(side="left")

        return {"row": row, "bar": bar, "count_lbl": count_lbl, "fail_lbl": fail_lbl}

    def _update_cat_row(self, slug: str, info: dict):
        ref    = self._cat_rows[slug]
        total  = info.get("productCount", 0)
        done   = info.get("done", 0)
        failed = info.get("failed", 0)
        pct    = done / total if total else 0.0

        ref["bar"].set(pct)
        ref["count_lbl"].configure(text=f"{fmt(done)}/{fmt(total)}")

        if failed > 0:
            if ref["fail_lbl"] is None:
                ref["fail_lbl"] = ctk.CTkLabel(
                    ref["row"], text=f"⚠{failed}",
                    font=ctk.CTkFont(size=10, weight="bold"),
                    text_color="#ff6b6b", width=34)
                ref["fail_lbl"].pack(side="left")
            else:
                ref["fail_lbl"].configure(text=f"⚠{failed}")
        elif ref["fail_lbl"] is not None:
            ref["fail_lbl"].pack_forget()
            ref["fail_lbl"].destroy()
            ref["fail_lbl"] = None

    def _render_cat_rows(self, cats: dict):
        def sort_key(item):
            _, info = item
            total  = info.get("productCount", 0)
            done   = info.get("done", 0)
            pct    = done / total if total else 0.0
            failed = info.get("failed", 0)
            return (2 if pct >= 1.0 else 0, pct, -failed)

        sorted_cats = sorted(cats.items(), key=sort_key)
        self._cat_count_lbl.configure(text=f"{len(sorted_cats)}")

        new_order = [s for s, _ in sorted_cats]
        old_order = list(self._cat_rows.keys())

        if new_order != old_order:
            for w in self._cat_scroll.winfo_children():
                w.destroy()
            self._cat_rows = {}
            for slug, info in sorted_cats:
                self._cat_rows[slug] = self._make_cat_row(slug, info)
        else:
            for slug, info in sorted_cats:
                self._update_cat_row(slug, info)

    # ─── RUNNER PANEL ─────────────────────────────────────────────────────────

    def _build_runner_panel(self, parent):
        t = self._theme

        ctrl = ctk.CTkFrame(parent, fg_color=t["card_bg"], corner_radius=18)
        ctrl.pack(fill="x", padx=12, pady=(14, 6))

        ctk.CTkLabel(ctrl, text="Run Settings",
                     font=ctk.CTkFont(size=13, weight="bold")).grid(
            row=0, column=0, columnspan=4, sticky="w", padx=18, pady=(12, 4))

        # Workers slider
        ctk.CTkLabel(ctrl, text="Workers:", font=ctk.CTkFont(size=12),
                     text_color=t["subtext"]).grid(row=1, column=0, padx=(18, 4), pady=7, sticky="w")
        self._conc_slider = ctk.CTkSlider(
            ctrl, from_=1, to=10, number_of_steps=9, width=170,
            progress_color=t["highlight"], button_color=t["highlight"],
            command=self._on_concurrency_change)
        self._conc_slider.set(3)
        self._conc_slider.grid(row=1, column=1, padx=4, pady=7)
        self._conc_lbl = ctk.CTkLabel(ctrl, text="3", width=22,
                                      font=ctk.CTkFont(size=13, weight="bold"),
                                      text_color=t["highlight"])
        self._conc_lbl.grid(row=1, column=2, padx=(2, 18), pady=7)

        # Time limit
        ctk.CTkLabel(ctrl, text="Time limit:", font=ctk.CTkFont(size=12),
                     text_color=t["subtext"]).grid(row=2, column=0, padx=(18, 4), pady=7, sticky="w")
        self._time_seg = ctk.CTkSegmentedButton(
            ctrl, values=TIME_LIMIT_LABELS,
            selected_color=t["highlight"], selected_hover_color=t["btn_run_h"],
            command=self._on_time_limit_change)
        self._time_seg.set(TIME_LIMIT_LABELS[0])
        self._time_seg.grid(row=2, column=1, columnspan=2, padx=4, pady=7, sticky="w")

        # Category filter
        ctk.CTkLabel(ctrl, text="Filter:", font=ctk.CTkFont(size=12),
                     text_color=t["subtext"]).grid(row=3, column=0, padx=(18, 4), pady=7, sticky="w")
        self._filter_var = ctk.StringVar(value="All mine")
        self._filter_menu = ctk.CTkOptionMenu(
            ctrl, variable=self._filter_var,
            values=["All mine", "Incomplete", "Failed"],
            width=170, fg_color=t["accent"], button_color=t["highlight"],
            dynamic_resizing=False,
            command=lambda _: self._update_cmd_preview())
        self._filter_menu.grid(row=3, column=1, padx=4, pady=7, sticky="w")

        # Buttons
        btn_row = ctk.CTkFrame(ctrl, fg_color="transparent")
        btn_row.grid(row=4, column=0, columnspan=4, padx=14, pady=(6, 8), sticky="w")

        self._run_btn = ctk.CTkButton(
            btn_row, text="▶  Run", width=100,
            fg_color=t["btn_run"], hover_color=t["btn_run_h"],
            command=self._run_normal)
        self._run_btn.pack(side="left", padx=(4, 6))

        self._stop_btn = ctk.CTkButton(
            btn_row, text="■  Stop", width=90,
            fg_color=t["btn_stop"], hover_color=t["btn_stop_h"],
            state="disabled", command=self._stop_script)
        self._stop_btn.pack(side="left", padx=(0, 6))

        self._cont_btn = ctk.CTkButton(
            btn_row, text="↺  Continue", width=110,
            fg_color=t["accent"], hover_color=t["highlight"],
            command=self._run_continue)
        self._cont_btn.pack(side="left", padx=(0, 6))

        self._cmd_lbl = ctk.CTkLabel(ctrl, text="", anchor="w",
                                     font=ctk.CTkFont(family="Courier", size=11),
                                     text_color=t["subtext"])
        self._cmd_lbl.grid(row=5, column=0, columnspan=4, padx=18, pady=(0, 12), sticky="w")

        self._update_cmd_preview()

        # Console
        ctk.CTkLabel(parent, text="Console Output",
                     font=ctk.CTkFont(size=12, weight="bold")).pack(
            anchor="w", padx=14, pady=(6, 2))

        wrap = ctk.CTkFrame(parent, fg_color="#0d0d0d", corner_radius=12)
        wrap.pack(fill="both", expand=True, padx=12, pady=(0, 4))

        self._console = tk.Text(wrap, bg="#0d0d0d", fg="#cccccc",
                                insertbackground="#cccccc", selectbackground="#333",
                                font=("Courier", 12), wrap="word",
                                relief="flat", state="disabled", padx=10, pady=8)
        self._console.pack(fill="both", expand=True, side="left")

        scr = ctk.CTkScrollbar(wrap, command=self._console.yview)
        scr.pack(fill="y", side="right")
        self._console.configure(yscrollcommand=scr.set)

        self._console.tag_config("error",  foreground="#ff6b6b")
        self._console.tag_config("warn",   foreground="#ffd93d")
        self._console.tag_config("info",   foreground="#6bcb77")
        self._console.tag_config("saved",  foreground="#4dabf7")
        self._console.tag_config("header", foreground="#a29bfe")
        self._console.tag_config("skip",   foreground="#888888")
        self._console.tag_config("normal", foreground="#cccccc")

    def _build_bottom_bar(self):
        t = self._theme
        bar = ctk.CTkFrame(self, height=50, corner_radius=0, fg_color=t["nav_bg"])
        bar.pack(fill="x", side="bottom")

        ctk.CTkButton(bar, text="⚠ Run Failed", width=110, height=34,
                      fg_color=t["btn_stop"], hover_color=t["btn_stop_h"],
                      font=ctk.CTkFont(size=11),
                      command=self._run_failed).pack(side="left", padx=(10, 4), pady=8)

        ctk.CTkButton(bar, text="◑ Run Partial", width=110, height=34,
                      fg_color=t["accent"], hover_color=t["highlight"],
                      font=ctk.CTkFont(size=11),
                      command=self._run_partial).pack(side="left", padx=4, pady=8)

        ctk.CTkButton(bar, text="↑ Sync Now", width=100, height=34,
                      fg_color=t["accent"], hover_color=t["highlight"],
                      font=ctk.CTkFont(size=11),
                      command=self._trigger_sync).pack(side="left", padx=4, pady=8)

        ctk.CTkButton(bar, text="Clear", width=70, height=34,
                      fg_color="#333", hover_color="#444",
                      font=ctk.CTkFont(size=11),
                      command=self._clear_console).pack(side="right", padx=10, pady=8)

        self._lines_lbl = ctk.CTkLabel(bar, text="0 lines",
                                       font=ctk.CTkFont(size=11), text_color="#666")
        self._lines_lbl.pack(side="right", padx=6)

    # ─── STATS ───────────────────────────────────────────────────────────────

    def _refresh_stats(self):
        threading.Thread(target=self._fetch_stats, daemon=True).start()

    def _fetch_stats(self):
        meta = read_json(META_FILE)
        if not meta:
            meta = {
                "totals": {t: {"done": 0, "total": 0, "reviews": 0, "failed": 0}
                           for t in ["arda", "tugce", "havvagul"]},
                "categories": {},
            }
        totals = meta.get("totals", {})
        if all(totals.get(t, {}).get("total", 0) == 0 for t in ["arda", "tugce", "havvagul"]):
            assignments = (meta.get("assignments")
                           or read_json(LOGS_DIR / "team_assignments.json"))
            if assignments:
                meta = self._build_stats_from_fs(meta, assignments)
        self.after(0, lambda m=meta: self._apply_stats(m))

    def _build_stats_from_fs(self, meta: dict, assignments: dict) -> dict:
        cache = getattr(self, "_fs_stats_cache", None)
        if cache:
            return cache
        ids_dir = SCRIPT_DIR / "product_ids"
        raw_dir = SCRIPT_DIR / "raw_data"
        cats = dict(meta.get("categories", {}))
        totals = {}
        for team in ["arda", "tugce", "havvagul"]:
            slugs = assignments.get(team, [])
            team_total, team_done = 0, 0
            for slug in slugs:
                ids_file = ids_dir / f"{slug}_ids.json"
                product_count = 0
                if ids_file.exists():
                    d = read_json(str(ids_file))
                    if d:
                        product_count = d.get("uniqueCount", len(d.get("products", [])))
                team_total += product_count
                cat_raw = raw_dir / slug
                done_count = (len(list(cat_raw.glob("*_reviews.json")))
                              if cat_raw.exists() else 0)
                team_done += done_count
                if slug not in cats:
                    cats[slug] = {
                        "team": team, "productCount": product_count,
                        "done": done_count, "reviews": 0, "failed": 0,
                    }
            totals[team] = {"done": team_done, "total": team_total,
                            "reviews": 0, "failed": 0}
        result = dict(meta)
        result["totals"] = totals
        result["categories"] = cats
        self._fs_stats_cache = result
        return result

    def _apply_stats(self, meta: dict):
        totals = meta.get("totals", {})
        ov_done    = sum(t.get("done",    0) for t in totals.values())
        ov_total   = sum(t.get("total",   0) for t in totals.values())
        ov_reviews = sum(t.get("reviews", 0) for t in totals.values())
        update_card(self._overall_card, ov_done, ov_total, ov_reviews)

        for team, card in self._team_cards.items():
            t = totals.get(team, {})
            update_card(card, t.get("done", 0), t.get("total", 0), t.get("reviews", 0))

        cats    = meta.get("categories", {})
        my_cats = {s: i for s, i in cats.items() if i.get("team") == self._user}
        self._render_cat_rows(my_cats)

    def _start_auto_refresh(self):
        self._refresh_stats()
        self._refresh_after_id = self.after(REFRESH_INTERVAL, self._start_auto_refresh)

    # ─── COMMAND BUILDING ─────────────────────────────────────────────────────

    def _build_exec_cmd(self, run_type="normal") -> list:
        u    = self._user
        conc = self._concurrency_val
        tl   = TIME_LIMIT_STEPS[self._time_limit_idx]
        filt = self._filter_var.get() if hasattr(self, "_filter_var") else "All mine"

        if run_type == "failed":
            return ["node", str(NODE_SCRIPT),
                    f"--user={u}", f"--concurrency={conc}", "--failed-only"]

        if run_type == "partial":
            return ["node", str(NODE_SCRIPT),
                    f"--user={u}", f"--concurrency={conc}", "--partial-only"]

        cmd = ["node", str(NODE_SCRIPT),
               f"--user={u}", f"--team={u}", f"--concurrency={conc}"]

        if filt == "Incomplete":
            cmd.append("--incomplete-only")
        elif filt == "Failed":
            return ["node", str(NODE_SCRIPT),
                    f"--user={u}", f"--concurrency={conc}", "--failed-only"]

        if tl > 0:
            cmd.append(f"--time-limit={tl}")

        return cmd

    def _update_cmd_preview(self, run_type="normal"):
        if not hasattr(self, "_cmd_lbl"):
            return
        cmd = self._build_exec_cmd(run_type)
        short = " ".join(
            str(p).replace(str(SCRIPT_DIR) + "/", "").replace(str(SCRIPT_DIR) + "\\", "")
            for p in cmd)
        self._cmd_lbl.configure(text=f"→  {short}")

    # ─── RUN / STOP ───────────────────────────────────────────────────────────

    def _run_normal(self):   self._launch("normal")
    def _run_continue(self): self._launch("normal")
    def _run_failed(self):   self._launch("failed")
    def _run_partial(self):  self._launch("partial")

    def _launch(self, run_type: str):
        if self._running_proc is not None:
            return
        cmd = self._build_exec_cmd(run_type)
        self._run_btn.configure(state="disabled")
        self._cont_btn.configure(state="disabled")
        self._stop_btn.configure(state="normal")
        self._set_status(f"● Running ({run_type})", self._theme["highlight"])
        self._stop_event.clear()

        hdr = f"[{ts_now()}] ▶  {' '.join(str(c) for c in cmd)}\n"
        self._console_write(hdr, "header")

        threading.Thread(target=self._proc_thread, args=(cmd,), daemon=True).start()

    def _proc_thread(self, cmd):
        try:
            proc = subprocess.Popen(
                [str(c) for c in cmd],
                cwd=str(SCRIPT_DIR),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1,
            )
            self._running_proc = proc
            for line in proc.stdout:
                if self._stop_event.is_set():
                    proc.terminate()
                    break
                self.after(0, lambda l=line: self._console_write(l))
            proc.wait()
            rc  = proc.returncode
            msg = f"\n[{ts_now()}] ● Process exited (code {rc})\n"
            tag = "info" if rc == 0 else "error"
            self.after(0, lambda m=msg, t=tag: self._console_write(m, t))
        except FileNotFoundError:
            self.after(0, lambda: self._console_write(
                "[ERROR] node not found — install Node.js and ensure it is on PATH.\n", "error"))
        except Exception as e:
            self.after(0, lambda err=e: self._console_write(f"[ERROR] {err}\n", "error"))
        finally:
            self._running_proc = None
            self.after(0, self._on_finished)
            self.after(800, self._refresh_stats)
            self.after(2000, self._trigger_sync)

    def _stop_script(self):
        self._stop_event.set()
        if self._running_proc:
            try: self._running_proc.terminate()
            except Exception: pass
        self._console_write(f"\n[{ts_now()}] ■  Stop requested.\n", "warn")

    def _on_finished(self):
        self._fs_stats_cache = None  # invalidate so next refresh rescans
        self._run_btn.configure(state="normal")
        self._cont_btn.configure(state="normal")
        self._stop_btn.configure(state="disabled")
        self._set_status("● Idle", "#888")
        state_file = LOGS_DIR / f"state_{self._user}.json"
        state = read_json(state_file)
        if state:
            failed_count = len(state.get("failedJobs", []))
            if failed_count > 0:
                self.after(600, lambda: self._show_failed_dialog(failed_count))

    # ─── FAILED DIALOG ────────────────────────────────────────────────────────

    def _show_failed_dialog(self, failed_count: int):
        d = ctk.CTkToplevel(self)
        d.title("Failed Jobs")
        d.geometry("420x190")
        d.resizable(False, False)
        d.lift(); d.focus(); d.grab_set()

        ctk.CTkLabel(d, text=f"⚠  {failed_count} job(s) failed in this run.",
                     font=ctk.CTkFont(size=14, weight="bold")).pack(pady=(24, 8))
        ctk.CTkLabel(d, text="Retry the failed jobs now?",
                     font=ctk.CTkFont(size=12), text_color="#888").pack(pady=(0, 20))

        row = ctk.CTkFrame(d, fg_color="transparent")
        row.pack()

        ctk.CTkButton(row, text="▶  Retry", width=130,
                      fg_color=self._theme["btn_run"], hover_color=self._theme["btn_run_h"],
                      command=lambda: (d.destroy(), self._run_failed())).pack(side="left", padx=8)
        ctk.CTkButton(row, text="Skip", width=80,
                      fg_color="#333", hover_color="#555",
                      command=d.destroy).pack(side="left", padx=8)

    # ─── CONSOLE ─────────────────────────────────────────────────────────────

    def _console_write(self, text: str, tag: str | None = None):
        if tag is None:
            tag = self._auto_tag(text)
        self._console.configure(state="normal")
        self._console.insert("end", text, tag)
        self._console.see("end")

        line_count = int(self._console.index("end-1c").split(".")[0])
        if line_count > MAX_CONSOLE_LINES:
            trim_to = line_count - CONSOLE_TRIM_TO
            self._console.delete("1.0", f"{trim_to}.0")
            line_count = CONSOLE_TRIM_TO

        self._console.configure(state="disabled")
        self._lines_lbl.configure(text=f"{line_count:,} lines")

    def _auto_tag(self, text: str) -> str:
        t = text.lower()
        if "error" in t or "fatal" in t or "fail" in t: return "error"
        if "warn"  in t or "retry" in t:                return "warn"
        if "saved" in t:                                 return "saved"
        if "skip"  in t:                                 return "skip"
        if t.startswith("[run]") or t.startswith("[start review]"): return "header"
        if "done" in t or "finished" in t:               return "info"
        return "normal"

    def _clear_console(self):
        self._console.configure(state="normal")
        self._console.delete("1.0", "end")
        self._console.configure(state="disabled")
        self._lines_lbl.configure(text="0 lines")

    # ─── CONTROLS ────────────────────────────────────────────────────────────

    def _on_concurrency_change(self, value):
        v = max(1, min(10, int(round(float(value)))))
        self._concurrency_val = v
        self._conc_lbl.configure(text=str(v))
        self._conc_slider.set(v)
        self._update_cmd_preview()

    def _on_time_limit_change(self, value):
        try: self._time_limit_idx = TIME_LIMIT_LABELS.index(value)
        except ValueError: self._time_limit_idx = 0
        self._update_cmd_preview()

    def _set_status(self, text: str, color: str = "#888"):
        self._status_lbl.configure(text=text, text_color=color)

    # ─── GIT SYNC ────────────────────────────────────────────────────────────

    def _start_git_sync_thread(self):
        stop = self._stop_event
        def worker():
            while not stop.wait(GIT_SYNC_INTERVAL):
                self._do_git_sync()
        threading.Thread(target=worker, daemon=True).start()

    def _trigger_sync(self):
        threading.Thread(target=self._do_git_sync, daemon=True).start()

    def _do_git_sync(self):
        with self._sync_lock:
            self.after(0, lambda: self._sync_lbl.configure(
                text="git: ↑ syncing…", text_color="#ffd93d"))
            try:
                def run(*args):
                    return subprocess.run(list(args), capture_output=True,
                                         cwd=str(REPO_ROOT), timeout=30)
                run("git", "pull", "--rebase", "--quiet")
                run("git", "add", "-f", *GIT_SYNC_FILES)
                diff = run("git", "diff", "--cached", "--quiet")
                if diff.returncode != 0:
                    msg = f"meta: sync {self._user} {datetime.now().strftime('%Y-%m-%dT%H:%M')}"
                    run("git", "commit", "--no-verify", "-m", msg)
                    run("git", "push", "--quiet")
                self._last_sync_ts = datetime.now().strftime("%H:%M")
                self.after(0, lambda: self._sync_lbl.configure(
                    text=f"git: ✓ {self._last_sync_ts}", text_color="#6bcb77"))
            except subprocess.TimeoutExpired:
                self.after(0, lambda: self._sync_lbl.configure(
                    text="git: timeout", text_color="#ffd93d"))
            except Exception:
                self.after(0, lambda: self._sync_lbl.configure(
                    text="git: ⚠ failed", text_color="#ff6b6b"))


# ─── ENTRY POINT ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    App().mainloop()
