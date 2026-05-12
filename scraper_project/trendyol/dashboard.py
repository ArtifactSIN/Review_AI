#!/usr/bin/env python3
"""
Trendyol scraper dashboard.

Usage:
  python dashboard.py                    # launch scraper + live dashboard
  python dashboard.py --concurrency=4   # launch with custom worker count
  python dashboard.py categories        # manage categories.txt
  python dashboard.py status            # show saved product_ids stats

Keys (during run):
  p   Pause / Resume
  q   Quit
"""

import os
import sys
import json
import re
import signal
import subprocess
import threading
import queue
import time
import select as sel_module
from pathlib import Path
from datetime import datetime, timedelta
from urllib.parse import urlparse

try:
    import tty
    import termios
    HAS_TERMIOS = True
except ImportError:
    HAS_TERMIOS = False

try:
    from rich.live import Live
    from rich.table import Table
    from rich.panel import Panel
    from rich.layout import Layout
    from rich.text import Text
    from rich.console import Console
    from rich import box
except ImportError:
    print("rich not installed. Run: pip install rich")
    sys.exit(1)

SCRIPT_DIR      = Path(__file__).parent
CATEGORIES_FILE = SCRIPT_DIR / "categories.txt"
PRODUCT_IDS_DIR = SCRIPT_DIR / "product_ids"
NODE_SCRIPT     = SCRIPT_DIR / "collect_category_ids.js"
TARGET          = 1000
QUEUE_MAX_ROWS  = 14

console = Console()

# ─── launcher presets ─────────────────────────────────────────────────────────

PRESETS = [
    {"label": "Full Run",                "hint": "all pending categories, skip completed",         "concurrency": 3, "min_products": 0,   "mode": "run"},
    {"label": "Re-check Empty   (< 10)", "hint": "re-scrape 0-9 product categories from page 1",  "concurrency": 3, "min_products": 10,  "mode": "run"},
    {"label": "Re-check Low    (< 50)",  "hint": "re-scrape anything below 50 products",           "concurrency": 3, "min_products": 50,  "mode": "run"},
    {"label": "Re-check Medium (< 200)", "hint": "re-scrape anything below 200 products",          "concurrency": 3, "min_products": 200, "mode": "run"},
    {"label": "High Speed      (c=5)",   "hint": "5 parallel workers — fast connection only",      "concurrency": 5, "min_products": 0,   "mode": "run"},
    {"label": "Audit Only",              "hint": "health check — no browser, print distribution",  "concurrency": 1, "min_products": 0,   "mode": "audit"},
    {"label": "Status Only",             "hint": "file-existence check — no browser, very fast",   "concurrency": 1, "min_products": 0,   "mode": "status"},
    {"label": "Custom...",               "hint": "set concurrency and min-products manually",       "concurrency": 3, "min_products": 0,   "mode": "custom"},
]

MIN_PRODUCTS_STEPS = [0, 5, 10, 25, 50, 100, 200, 300, 500]

# ─── state ────────────────────────────────────────────────────────────────────

class CategoryState:
    def __init__(self, slug, url):
        self.slug       = slug
        self.url        = url
        self.status     = "queued"   # queued | running | done | partial | error
        self.page       = 0
        self.total      = 0
        self.worker     = None
        self.started_at = None
        self.finished_at = None

    def progress_pct(self):
        return min(100, int(self.total / TARGET * 100))

    def eta_str(self):
        if self.status in ("done", "partial") or self.total == 0 or self.started_at is None:
            return "-"
        elapsed = time.time() - self.started_at
        rate = self.total / elapsed if elapsed > 0 else 0
        if rate == 0:
            return "?"
        remaining = (TARGET - self.total) / rate
        return str(timedelta(seconds=int(remaining)))


class RunState:
    def __init__(self):
        self.categories = {}    # slug → CategoryState
        self.log_lines  = []
        self.log_max    = 30
        self.started_at = time.time()
        self.node_pid   = None
        self.finished   = False
        self.paused     = False
        self.lock       = threading.Lock()

    def add_log(self, line):
        with self.lock:
            self.log_lines.append(line)
            if len(self.log_lines) > self.log_max:
                self.log_lines.pop(0)

    def get_log(self):
        with self.lock:
            return list(self.log_lines)

    def get_cats(self):
        with self.lock:
            return dict(self.categories)

    def update(self, fn):
        with self.lock:
            fn(self)

# ─── log parsing ──────────────────────────────────────────────────────────────

RE_START    = re.compile(r"^\[START\]\s+(.+)$")
RE_PROGRESS = re.compile(r"^\[(.+?)\]\s+pg=(\d+)\s+\+\d+\s+new,\s+total=(\d+)")
RE_SAVED    = re.compile(r"^\[SAVED\].+\((\d+)\s+products\)")
RE_PARTIAL  = re.compile(r"^\[PARTIAL SAVED\].+?([^/]+)_ids\.partial\.json")
RE_WORKER   = re.compile(r"^\[WORKER (\d+)\]\s+starting\s+(.+)$")
RE_ERROR    = re.compile(r"^\[ERROR\]\s+(.+)$")
RE_DONE_CAT = re.compile(r"^\[SAVED\].+?([^/\\]+)_ids\.json")


def slug_from_url(url):
    """Match node.js slugFromCategoryUrl logic exactly."""
    parsed = urlparse(url.strip())
    cleaned = parsed.path.strip("/").replace("/", "-")
    return cleaned or "category"


def parse_line(line, state):
    line = line.strip()
    if not line:
        return

    state.add_log(line)

    m = RE_WORKER.match(line)
    if m:
        wid, url = m.group(1), m.group(2)
        slug = slug_from_url(url)
        def f(s):
            if slug not in s.categories:
                s.categories[slug] = CategoryState(slug, url)
            s.categories[slug].worker = wid
        state.update(f)
        return

    m = RE_START.match(line)
    if m:
        slug = m.group(1).strip()
        def f(s):
            if slug not in s.categories:
                s.categories[slug] = CategoryState(slug, "")
            cat = s.categories[slug]
            cat.status = "running"
            cat.started_at = time.time()
        state.update(f)
        return

    m = RE_PROGRESS.match(line)
    if m:
        slug, pg, total = m.group(1), int(m.group(2)), int(m.group(3))
        def f(s):
            if slug not in s.categories:
                s.categories[slug] = CategoryState(slug, "")
            cat = s.categories[slug]
            cat.status = "running"
            cat.page   = pg
            cat.total  = total
            if cat.started_at is None:
                cat.started_at = time.time()
        state.update(f)
        return

    m = RE_DONE_CAT.match(line)
    if m:
        slug  = m.group(1)
        cm    = RE_SAVED.match(line)
        count = int(cm.group(1)) if cm else None
        def f(s):
            if slug not in s.categories:
                s.categories[slug] = CategoryState(slug, "")
            cat = s.categories[slug]
            cat.status      = "done"
            cat.finished_at = time.time()
            if count is not None:
                cat.total = count
        state.update(f)
        return

    m = RE_PARTIAL.match(line)
    if m:
        slug = m.group(1)
        def f(s):
            if slug in s.categories:
                s.categories[slug].status = "partial"
        state.update(f)
        return

    m = RE_ERROR.match(line)
    if m:
        url  = m.group(1)
        slug = slug_from_url(url)
        def f(s):
            if slug in s.categories:
                s.categories[slug].status = "error"
        state.update(f)
        return

# ─── rendering ────────────────────────────────────────────────────────────────

STATUS_STYLE = {
    "queued":  ("dim",        "○"),
    "running": ("cyan bold",  "◉"),
    "done":    ("green bold", "✓"),
    "partial": ("yellow",     "◑"),
    "error":   ("red bold",   "✗"),
}


def build_active_table(cats):
    running = [c for c in cats.values() if c.status == "running"]
    table = Table(box=box.SIMPLE_HEAVY, show_header=True, header_style="bold cyan")
    table.add_column("Category",  min_width=26)
    table.add_column("W",  width=3,  justify="center")
    table.add_column("Pg", width=5,  justify="right")
    table.add_column("Found", width=7, justify="right")
    table.add_column("Pct", width=6,  justify="right")
    table.add_column("ETA", width=9,  justify="right")

    if not running:
        table.add_row("[dim]No active workers[/dim]", "", "", "", "", "")
    else:
        for cat in running:
            pct = f"{cat.progress_pct()}%" if cat.total > 0 else "-"
            table.add_row(
                cat.slug,
                str(cat.worker) if cat.worker else "-",
                str(cat.page)   if cat.page   else "-",
                str(cat.total)  if cat.total  else "-",
                pct,
                cat.eta_str(),
            )
    return table


def build_queue_table(cats):
    queued = [c for c in cats.values() if c.status == "queued"]
    table  = Table(box=box.SIMPLE_HEAVY, show_header=True, header_style="bold white")
    table.add_column(f"Up Next  ({len(queued)} remaining)", min_width=28)

    for cat in queued[:QUEUE_MAX_ROWS]:
        table.add_row(cat.slug)

    overflow = len(queued) - QUEUE_MAX_ROWS
    if overflow > 0:
        table.add_row(f"[dim]  … {overflow} more[/dim]")

    if not queued:
        table.add_row("[dim]Queue empty[/dim]")

    return table


def build_log_panel(log_lines):
    lines = log_lines[-10:] if log_lines else ["No output yet."]
    text  = Text()
    for line in lines:
        if "[ERROR]" in line or "[FATAL]" in line:
            text.append(line + "\n", style="red")
        elif "[SAVED]" in line:
            text.append(line + "\n", style="green")
        elif "[PARTIAL" in line:
            text.append(line + "\n", style="yellow")
        elif "[START]" in line:
            text.append(line + "\n", style="cyan")
        else:
            text.append(line + "\n", style="dim")
    return Panel(text, title="[bold]Log[/bold]", border_style="blue")


def build_header(state, node_proc):
    cats        = state.get_cats()
    total_found = sum(c.total for c in cats.values())
    done_count  = sum(1 for c in cats.values() if c.status == "done")
    run_count   = sum(1 for c in cats.values() if c.status == "running")
    err_count   = sum(1 for c in cats.values() if c.status == "error")

    elapsed     = int(time.time() - state.started_at)
    elapsed_str = str(timedelta(seconds=elapsed))

    if state.paused:
        proc_label = "PAUSED"
        proc_style = "yellow bold"
    elif node_proc and node_proc.poll() is None:
        proc_label = "RUNNING"
        proc_style = "green bold"
    else:
        proc_label = "STOPPED"
        proc_style = "red bold"

    text = Text()
    text.append("  TRENDYOL SCRAPER  ", style="white bold on blue")
    text.append("  Status: ")
    text.append(proc_label, style=proc_style)
    text.append(f"  │  Elapsed: {elapsed_str}")
    text.append(f"  │  Done: {done_count}/{len(cats)}")
    text.append(f"  │  Active: {run_count}")
    if err_count:
        text.append(f"  │  Errors: {err_count}", style="red")
    text.append(f"  │  Products: {total_found}")
    text.append("  │  ")
    text.append("[P]", style="bold yellow")
    text.append(" Pause/Resume  ")
    text.append("[Q]", style="bold red")
    text.append(" Quit")
    return Panel(text, border_style="blue")


def build_display(state, node_proc):
    cats       = state.get_cats()
    log        = state.get_log()
    header     = build_header(state, node_proc)
    active_tbl = build_active_table(cats)
    queue_tbl  = build_queue_table(cats)
    log_panel  = build_log_panel(log)

    done    = sum(1 for c in cats.values() if c.status == "done")
    partial = sum(1 for c in cats.values() if c.status == "partial")
    error   = sum(1 for c in cats.values() if c.status == "error")
    summary = Text()
    summary.append(f"  ✓ done: {done}   ", style="green bold")
    summary.append(f"◑ partial: {partial}   ", style="yellow")
    summary.append(f"✗ error: {error}", style="red bold")
    summary_panel = Panel(summary, title="[bold]Completed[/bold]", border_style="dim")

    layout = Layout()
    layout.split_column(
        Layout(header,       size=3),
        Layout(name="mid",   size=18),
        Layout(summary_panel, size=3),
        Layout(log_panel,    size=14),
    )
    layout["mid"].split_row(
        Layout(Panel(active_tbl, title="[bold cyan]◉ Active Workers[/bold cyan]", border_style="cyan"), ratio=1),
        Layout(Panel(queue_tbl,  title="[bold]○ Queue[/bold]",                   border_style="dim"),  ratio=1),
    )
    return layout

# ─── keyboard input ────────────────────────────────────────────────────────────

def key_reader_thread(key_queue, stop_event):
    if not HAS_TERMIOS:
        return
    fd  = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        while not stop_event.is_set():
            r, _, _ = sel_module.select([fd], [], [], 0.1)
            if r:
                ch = os.read(fd, 1)
                key_queue.put(ch.decode("ascii", errors="replace").lower())
    except Exception:
        pass
    finally:
        try:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        except Exception:
            pass

# ─── subprocess management ────────────────────────────────────────────────────

def stdout_reader(proc, state, line_queue):
    try:
        for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip()
            line_queue.put(line)
    except Exception:
        pass
    finally:
        line_queue.put(None)

# ─── run mode ─────────────────────────────────────────────────────────────────

def run_dashboard(concurrency=3, min_products=0):
    if not NODE_SCRIPT.exists():
        console.print(f"[red]Not found: {NODE_SCRIPT}[/red]")
        sys.exit(1)

    cats_raw = read_categories()
    if not cats_raw:
        console.print("[red]categories.txt is empty.[/red]")
        sys.exit(1)

    state = RunState()
    with state.lock:
        for url in cats_raw:
            slug = slug_from_url(url)
            state.categories[slug] = CategoryState(slug, url)

    cmd = ["node", str(NODE_SCRIPT), f"--concurrency={concurrency}"]
    if min_products > 0:
        cmd.append(f"--min-products={min_products}")
    console.print(f"[dim]Launching: {' '.join(cmd)}[/dim]")

    node_proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(SCRIPT_DIR),
    )
    state.node_pid = node_proc.pid

    line_queue = queue.Queue()
    key_queue  = queue.Queue()
    stop_event = threading.Event()

    threading.Thread(target=stdout_reader, args=(node_proc, state, line_queue), daemon=True).start()
    threading.Thread(target=key_reader_thread, args=(key_queue, stop_event), daemon=True).start()

    def shutdown(sig=None, frame=None):
        if state.paused:
            try:
                node_proc.send_signal(signal.SIGCONT)
            except Exception:
                pass
        console.print("\n[yellow]Stopping...[/yellow]")
        try:
            node_proc.send_signal(signal.SIGINT)
        except Exception:
            node_proc.terminate()
        state.finished = True
        stop_event.set()

    signal.signal(signal.SIGINT, shutdown)

    with Live(console=console, refresh_per_second=2, screen=False) as live:
        while True:
            # Drain stdout
            try:
                while True:
                    line = line_queue.get_nowait()
                    if line is None:
                        state.finished = True
                        break
                    parse_line(line, state)
            except queue.Empty:
                pass

            # Handle keypresses
            try:
                while True:
                    ch = key_queue.get_nowait()
                    if ch == 'p' and node_proc.poll() is None:
                        if state.paused:
                            node_proc.send_signal(signal.SIGCONT)
                            state.paused = False
                            state.add_log("[DASHBOARD] Resumed.")
                        else:
                            node_proc.send_signal(signal.SIGSTOP)
                            state.paused = True
                            state.add_log("[DASHBOARD] Paused.")
                    elif ch in ('q',):
                        shutdown()
            except queue.Empty:
                pass

            live.update(build_display(state, node_proc))

            if state.finished or node_proc.poll() is not None:
                time.sleep(0.5)
                try:
                    while True:
                        line = line_queue.get_nowait()
                        if line is None:
                            break
                        parse_line(line, state)
                except queue.Empty:
                    pass
                live.update(build_display(state, node_proc))
                break

            time.sleep(0.5)

    stop_event.set()
    node_proc.wait()
    show_status()

# ─── status mode ──────────────────────────────────────────────────────────────

def show_status():
    console.print()
    if not PRODUCT_IDS_DIR.exists():
        console.print("[dim]No product_ids/ directory yet.[/dim]")
        return

    files    = sorted(PRODUCT_IDS_DIR.glob("*_ids.json"))
    partials = {f.stem.replace("_ids", ""): f for f in PRODUCT_IDS_DIR.glob("*_ids.partial.json")}

    if not files:
        console.print("[dim]No completed category files.[/dim]")
        return

    table = Table(title="Saved Product ID Files", box=box.SIMPLE_HEAVY, header_style="bold white")
    table.add_column("Category", style="white")
    table.add_column("Products",     justify="right")
    table.add_column("Collected At", justify="right", style="dim")
    table.add_column("File",         style="dim")

    total = 0
    for f in files:
        if ".partial." in f.name:
            continue
        try:
            data  = json.loads(f.read_text(encoding="utf-8"))
            count = data.get("uniqueCount", len(data.get("products", data.get("ids", []))))
            ctime = data.get("collectedAt", "?")[:19].replace("T", " ")
            total += count
            table.add_row(data.get("slug", f.stem), str(count), ctime, f.name)
        except Exception:
            table.add_row(f.stem, "?", "?", f.name)

    console.print(table)
    console.print(f"[bold]Total: {total} products across {len(files)} categories[/bold]")
    if partials:
        console.print(f"[yellow]{len(partials)} partial file(s): {', '.join(partials.keys())}[/yellow]")

# ─── category manager ─────────────────────────────────────────────────────────

def read_categories():
    if not CATEGORIES_FILE.exists():
        return []
    return [
        line.strip()
        for line in CATEGORIES_FILE.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def write_categories(urls):
    CATEGORIES_FILE.write_text("\n".join(urls) + "\n", encoding="utf-8")


def manage_categories():
    while True:
        urls = read_categories()

        console.print()
        table = Table(title="trendyol/categories.txt", box=box.SIMPLE, header_style="bold white")
        table.add_column("#",    width=4, justify="right")
        table.add_column("URL",  style="cyan")
        table.add_column("Slug", style="dim")

        for i, url in enumerate(urls, 1):
            table.add_row(str(i), url, slug_from_url(url))

        if not urls:
            console.print("[dim]  (empty)[/dim]")
        else:
            console.print(table)

        console.print("[bold]  a[/bold] add  [bold]r[/bold] remove  [bold]q[/bold] quit")
        try:
            choice = input("  > ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            break

        if choice == "q":
            break
        elif choice == "a":
            try:
                url = input("  URL: ").strip()
            except (EOFError, KeyboardInterrupt):
                continue
            if url.startswith("https://www.trendyol.com"):
                if url not in urls:
                    urls.append(url)
                    write_categories(urls)
                    console.print(f"[green]Added: {url}[/green]")
                else:
                    console.print("[yellow]Already in list.[/yellow]")
            else:
                console.print("[red]URL must start with https://www.trendyol.com[/red]")
        elif choice == "r":
            try:
                idx = int(input("  Number to remove: ").strip()) - 1
            except (ValueError, EOFError, KeyboardInterrupt):
                continue
            if 0 <= idx < len(urls):
                removed = urls.pop(idx)
                write_categories(urls)
                console.print(f"[yellow]Removed: {removed}[/yellow]")
            else:
                console.print("[red]Invalid number.[/red]")
        else:
            console.print("[dim]Unknown command.[/dim]")

# ─── launcher ─────────────────────────────────────────────────────────────────

def get_quick_stats():
    s = {"total_cats": 0, "files": 0, "empty": 0, "low": 0, "partial": 0, "capped": 0, "pending": 0}
    if CATEGORIES_FILE.exists():
        s["total_cats"] = sum(1 for l in CATEGORIES_FILE.read_text(encoding="utf-8").splitlines() if l.strip())
    if not PRODUCT_IDS_DIR.exists():
        s["pending"] = s["total_cats"]
        return s
    done_files = [f for f in PRODUCT_IDS_DIR.glob("*_ids.json") if ".partial." not in f.name]
    s["files"]   = len(done_files)
    s["partial"] = len(list(PRODUCT_IDS_DIR.glob("*_ids.partial.json")))
    s["pending"] = max(0, s["total_cats"] - s["files"] - s["partial"])
    for f in done_files:
        try:
            count = json.loads(f.read_text(encoding="utf-8")).get("uniqueCount", 0)
            if count == 0:       s["empty"]  += 1
            elif count < 50:     s["low"]    += 1
            elif count >= 1000:  s["capped"] += 1
        except Exception:
            pass
    return s


def _build_node_cmd(cfg):
    if cfg["mode"] == "audit":
        return ["node", "collect_category_ids.js", "--audit"]
    if cfg["mode"] == "status":
        return ["node", "collect_category_ids.js", "--status"]
    cmd = ["node", "collect_category_ids.js", f"--concurrency={cfg['concurrency']}"]
    if cfg.get("min_products", 0) > 0:
        cmd.append(f"--min-products={cfg['min_products']}")
    return cmd



class Launcher:
    def __init__(self):
        self.idx            = 0
        self.in_custom      = False
        self.cfield         = 0   # 0 = concurrency, 1 = min_products
        self.custom_conc    = 3
        self.custom_min_idx = 0   # index into MIN_PRODUCTS_STEPS
        self.stats          = get_quick_stats()

    # ── helpers ────────────────────────────────────────────────────────────────

    def _resolve_cfg(self):
        p = PRESETS[self.idx].copy()
        if p["mode"] == "custom":
            p["concurrency"]  = self.custom_conc
            p["min_products"] = MIN_PRODUCTS_STEPS[self.custom_min_idx]
            p["mode"]         = "run"
        return p

    # ── panels ─────────────────────────────────────────────────────────────────

    def _header(self):
        if self.in_custom:
            hint = "[bold]↑↓[/bold] field  [bold]←→[/bold] adjust  [bold]ENTER[/bold] confirm  [bold]ESC[/bold] cancel"
        else:
            hint = "[bold]↑↓[/bold] navigate  [bold]ENTER[/bold] launch  [bold]Q[/bold] quit"
        return Panel(
            Text.from_markup(f"  [white bold on blue] TRENDYOL SCRAPER [/white bold on blue]  {hint}"),
            border_style="blue",
        )

    def _preset_list(self):
        t = Table(box=box.SIMPLE_HEAVY, show_header=False, padding=(0, 1))
        t.add_column("Mode", min_width=30)
        for i, p in enumerate(PRESETS):
            if i == self.idx:
                t.add_row(f"[bold cyan on grey11] ▶  {p['label']} [/bold cyan on grey11]")
            else:
                t.add_row(f"[dim]    {p['label']}[/dim]")
        border = "cyan" if not self.in_custom else "dim"
        return Panel(t, title="[bold]Select Run Mode[/bold]", border_style=border)

    def _config_preview(self):
        p   = PRESETS[self.idx]
        cfg = self._resolve_cfg()
        cmd = _build_node_cmd(cfg)
        mp  = cfg.get("min_products", 0)

        t = Text()
        t.append("  Mode:          ", style="dim"); t.append(f"{p['label']}\n",                             style="bold white")
        t.append("  Concurrency:   ", style="dim"); t.append(f"{cfg['concurrency']} workers\n",              style="cyan")
        t.append("  Min Products:  ", style="dim"); t.append(f"{'none' if mp == 0 else f'< {mp}'}\n\n",     style="yellow" if mp else "dim")
        t.append(f"  {p['hint']}\n\n",              style="dim italic")
        t.append("  Command:\n",                    style="dim")
        t.append(f"  {' '.join(cmd)}\n",            style="green")
        return Panel(t, title="[bold]Configuration[/bold]", border_style="cyan")

    def _custom_panel(self):
        mp     = MIN_PRODUCTS_STEPS[self.custom_min_idx]
        cs     = "bold cyan" if self.cfield == 0 else "white"
        ms     = "bold cyan" if self.cfield == 1 else "white"

        t = Text()
        t.append("\n  ↑↓ switch field   ←→ adjust value\n\n", style="dim")

        t.append("  Concurrency    ", style="dim")
        t.append("◄", style=cs); t.append(f"  {self.custom_conc}  ", style=cs); t.append("►", style=cs)
        t.append("   workers  (1 – 10)\n\n", style="dim")

        t.append("  Min Products   ", style="dim")
        t.append("◄", style=ms); t.append(f"  {'none' if mp == 0 else str(mp)}  ", style=ms); t.append("►", style=ms)
        if mp:
            t.append(f"   re-run if < {mp}", style="dim")
        t.append("\n\n", style="dim")
        t.append("  ENTER  confirm     ESC  cancel\n", style="dim")
        return Panel(t, title="[bold cyan]Custom Configuration[/bold cyan]", border_style="cyan")

    def _stats_bar(self):
        s = self.stats
        t = Text()
        def stat(label, val, style="white"):
            t.append(f"  {label}: ", style="dim"); t.append(str(val), style=style); t.append("  │", style="dim")
        stat("categories", s["total_cats"])
        stat("files",      s["files"])
        stat("empty",  s["empty"],  "red bold"    if s["empty"]   else "dim")
        stat("low",    s["low"],    "yellow bold"  if s["low"]    else "dim")
        stat("partial",s["partial"],"yellow"       if s["partial"] else "dim")
        stat("pending",s["pending"],"red"          if s["pending"] else "dim")
        return Panel(t, title="[bold dim]Current State[/bold dim]", border_style="dim")

    # ── layout ─────────────────────────────────────────────────────────────────

    def render(self):
        layout = Layout()
        layout.split_column(
            Layout(self._header(),    size=3),
            Layout(name="body",       ratio=1),
            Layout(self._stats_bar(), size=3),
        )
        right = self._custom_panel() if self.in_custom else self._config_preview()
        layout["body"].split_row(
            Layout(self._preset_list(), ratio=2),
            Layout(right,               ratio=3),
        )
        return layout

    # ── key reading (background thread, same pattern as key_reader_thread) ────────

    def _start_key_thread(self, key_queue, stop_event):
        def _thread():
            fd  = sys.stdin.fileno()
            old = termios.tcgetattr(fd)
            try:
                tty.setcbreak(fd)
                while not stop_event.is_set():
                    # Use raw fd in select — sys.stdin (TextIOWrapper) drains the OS
                    # buffer on read(1), so subsequent select([sys.stdin]) sees no data
                    # even though the TextIOWrapper internal buffer still has [A/B/C/D.
                    r, _, _ = sel_module.select([fd], [], [], 0.1)
                    if not r:
                        continue
                    ch = os.read(fd, 1)          # raw read, no TextIOWrapper buffering
                    if ch == b"\x1b":
                        r2, _, _ = sel_module.select([fd], [], [], 0.15)
                        if r2:
                            ch2 = os.read(fd, 1)
                            if ch2 == b"[":
                                r3, _, _ = sel_module.select([fd], [], [], 0.15)
                                if r3:
                                    ch3 = os.read(fd, 1).decode("ascii", errors="replace")
                                    key_queue.put({"A": "up", "B": "down", "C": "right", "D": "left"}.get(ch3, "esc"))
                                    continue
                        key_queue.put("esc")
                    elif ch in (b"\r", b"\n"):
                        key_queue.put("enter")
                    elif ch == b"\x03":
                        key_queue.put("ctrl_c")
                    elif ch == b"\t":
                        key_queue.put("tab")
                    else:
                        key_queue.put(ch.decode("ascii", errors="replace").lower())
            except Exception:
                pass
            finally:
                try:
                    termios.tcsetattr(fd, termios.TCSADRAIN, old)
                except Exception:
                    pass
        threading.Thread(target=_thread, daemon=True).start()

    # ── interaction loop ───────────────────────────────────────────────────────

    def run(self):
        """Show launcher interactively. Returns chosen config dict, or None (quit)."""
        if not HAS_TERMIOS:
            console.print("[yellow]No interactive terminal — using Full Run defaults.[/yellow]")
            return PRESETS[0].copy()

        key_queue  = queue.Queue()
        stop_event = threading.Event()
        self._start_key_thread(key_queue, stop_event)

        result = None
        try:
            with Live(console=console, refresh_per_second=12, screen=True) as live:
                while True:
                    live.update(self.render())

                    try:
                        key = key_queue.get(timeout=0.08)
                    except queue.Empty:
                        continue

                    if key == "ctrl_c":
                        result = None
                        break

                    if self.in_custom:
                        if key == "esc":
                            self.in_custom = False
                        elif key in ("up", "k"):
                            self.cfield = max(0, self.cfield - 1)
                        elif key in ("down", "j", "tab"):
                            self.cfield = min(1, self.cfield + 1)
                        elif key in ("right", "l"):
                            if self.cfield == 0:
                                self.custom_conc = min(10, self.custom_conc + 1)
                            else:
                                self.custom_min_idx = min(len(MIN_PRODUCTS_STEPS) - 1, self.custom_min_idx + 1)
                        elif key in ("left", "h"):
                            if self.cfield == 0:
                                self.custom_conc = max(1, self.custom_conc - 1)
                            else:
                                self.custom_min_idx = max(0, self.custom_min_idx - 1)
                        elif key == "enter":
                            self.in_custom = False
                            result = self._resolve_cfg()
                            break
                    else:
                        if key in ("up", "k"):
                            self.idx = (self.idx - 1) % len(PRESETS)
                        elif key in ("down", "j"):
                            self.idx = (self.idx + 1) % len(PRESETS)
                        elif key in ("q", "esc"):
                            result = None
                            break
                        elif key == "enter":
                            if PRESETS[self.idx]["mode"] == "custom":
                                self.in_custom = True
                            else:
                                result = self._resolve_cfg()
                                break
        finally:
            stop_event.set()

        return result


# ─── entry point ──────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    # Parse explicit flags for direct (bypass-launcher) invocation
    concurrency  = None
    min_products = None
    positional   = []
    for arg in args:
        m = re.match(r"^--concurrency=(\d+)$", arg)
        if m:
            concurrency = int(m.group(1)); continue
        m = re.match(r"^--min-products=(\d+)$", arg)
        if m:
            min_products = int(m.group(1)); continue
        positional.append(arg)

    subcmd = positional[0] if positional else None

    # Subcommands that bypass the launcher
    if subcmd == "categories":
        manage_categories()
        return
    if subcmd == "status":
        show_status()
        return
    if subcmd == "audit":
        subprocess.run(["node", str(NODE_SCRIPT), "--audit"], cwd=str(SCRIPT_DIR))
        return
    if subcmd == "run" and concurrency is not None:
        # Direct launch: skip launcher when explicit flags are given
        run_dashboard(concurrency=concurrency, min_products=min_products or 0)
        return

    # Interactive launcher
    cfg = Launcher().run()
    if cfg is None:
        return  # user pressed Q

    if cfg["mode"] == "audit":
        subprocess.run(["node", str(NODE_SCRIPT), "--audit"], cwd=str(SCRIPT_DIR))
    elif cfg["mode"] == "status":
        show_status()
    else:
        run_dashboard(concurrency=cfg["concurrency"], min_products=cfg.get("min_products", 0))


if __name__ == "__main__":
    main()
