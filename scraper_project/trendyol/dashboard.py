#!/usr/bin/env python3
"""
Trendyol scraper dashboard.

Usage:
  python dashboard.py                    # launch scraper + live dashboard
  python dashboard.py --concurrency=4   # launch with custom worker count
  python dashboard.py categories        # manage categories.txt
  python dashboard.py status            # show saved product_ids stats
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
from pathlib import Path
from datetime import datetime, timedelta

try:
    from rich.live import Live
    from rich.table import Table
    from rich.panel import Panel
    from rich.layout import Layout
    from rich.text import Text
    from rich.console import Console
    from rich.columns import Columns
    from rich import box
except ImportError:
    print("rich not installed. Run: pip install rich")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).parent
CATEGORIES_FILE = SCRIPT_DIR / "categories.txt"
PRODUCT_IDS_DIR = SCRIPT_DIR / "product_ids"
NODE_SCRIPT = SCRIPT_DIR / "collect_category_ids.js"
TARGET = 1000

console = Console()

# ─── state ───────────────────────────────────────────────────────────────────

class CategoryState:
    def __init__(self, slug, url):
        self.slug = slug
        self.url = url
        self.status = "queued"   # queued | running | done | partial | error
        self.page = 0
        self.total = 0
        self.worker = None
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
        self.categories = {}   # slug → CategoryState
        self.log_lines = []    # last N raw log lines
        self.log_max = 30
        self.started_at = time.time()
        self.node_pid = None
        self.finished = False
        self.lock = threading.Lock()

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

# ─── log parsing ─────────────────────────────────────────────────────────────

RE_START    = re.compile(r"^\[START\]\s+(.+)$")
RE_PROGRESS = re.compile(r"^\[(.+?)\]\s+pg=(\d+)\s+\+\d+\s+new,\s+total=(\d+)")
RE_SAVED    = re.compile(r"^\[SAVED\].+\((\d+)\s+products\)")
RE_PARTIAL  = re.compile(r"^\[PARTIAL SAVED\].+?([^/]+)_ids\.partial\.json")
RE_WORKER   = re.compile(r"^\[WORKER (\d+)\]\s+starting\s+(.+)$")
RE_ERROR    = re.compile(r"^\[ERROR\]\s+(.+)$")
RE_FATAL    = re.compile(r"^\[FATAL\]")
RE_DONE_CAT = re.compile(r"^\[SAVED\].+?([^/\\]+)_ids\.json")

def slug_from_url(url):
    url = url.strip().rstrip("/")
    return url.split("/")[-1] or "category"

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
            cat = s.categories[slug]
            cat.worker = wid
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
            cat.page = pg
            cat.total = total
            if cat.started_at is None:
                cat.started_at = time.time()
        state.update(f)
        return

    m = RE_DONE_CAT.match(line)
    if m:
        slug = m.group(1)
        # extract count if present
        cm = RE_SAVED.match(line)
        count = int(cm.group(1)) if cm else None
        def f(s):
            if slug not in s.categories:
                s.categories[slug] = CategoryState(slug, "")
            cat = s.categories[slug]
            cat.status = "done"
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
        url = m.group(1)
        slug = slug_from_url(url)
        def f(s):
            if slug in s.categories:
                s.categories[slug].status = "error"
        state.update(f)
        return

# ─── rich rendering ──────────────────────────────────────────────────────────

STATUS_STYLE = {
    "queued":  ("dim", "○"),
    "running": ("cyan bold", "◉"),
    "done":    ("green bold", "✓"),
    "partial": ("yellow", "◑"),
    "error":   ("red bold", "✗"),
}

def build_progress_table(cats):
    table = Table(box=box.SIMPLE_HEAVY, show_header=True, header_style="bold white")
    table.add_column("Category", style="white", min_width=28)
    table.add_column("W", width=3, justify="center")
    table.add_column("Pg", width=5, justify="right")
    table.add_column("Found", width=7, justify="right")
    table.add_column("Pct", width=6, justify="right")
    table.add_column("ETA", width=8, justify="right")
    table.add_column("Status", width=9, justify="center")

    order = ["running", "queued", "partial", "done", "error"]
    sorted_cats = sorted(cats.values(), key=lambda c: order.index(c.status) if c.status in order else 9)

    for cat in sorted_cats:
        style, icon = STATUS_STYLE.get(cat.status, ("white", "?"))
        pct = f"{cat.progress_pct()}%" if cat.total > 0 else "-"
        table.add_row(
            cat.slug,
            str(cat.worker) if cat.worker else "-",
            str(cat.page) if cat.page else "-",
            str(cat.total) if cat.total else "-",
            pct,
            cat.eta_str(),
            Text(f"{icon} {cat.status}", style=style),
        )

    return table

def build_log_panel(log_lines):
    lines = log_lines[-12:] if log_lines else ["No output yet."]
    text = Text()
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
    return Panel(text, title="[bold]Log Output[/bold]", border_style="blue")

def build_header(state, node_proc):
    cats = state.get_cats()
    total_found = sum(c.total for c in cats.values())
    done_count = sum(1 for c in cats.values() if c.status == "done")
    running_count = sum(1 for c in cats.values() if c.status == "running")

    elapsed = int(time.time() - state.started_at)
    elapsed_str = str(timedelta(seconds=elapsed))

    proc_status = "RUNNING" if (node_proc and node_proc.poll() is None) else "STOPPED"
    proc_style = "green bold" if proc_status == "RUNNING" else "red bold"

    text = Text()
    text.append("  TRENDYOL SCRAPER  ", style="white bold on blue")
    text.append(f"  Process: ")
    text.append(proc_status, style=proc_style)
    text.append(f"  |  Elapsed: {elapsed_str}")
    text.append(f"  |  Categories: {done_count}/{len(cats)} done, {running_count} running")
    text.append(f"  |  Total products: {total_found}")
    text.append("  |  Ctrl+C to stop")
    return Panel(text, border_style="blue")

def build_display(state, node_proc):
    cats = state.get_cats()
    log = state.get_log()
    header = build_header(state, node_proc)
    table = build_progress_table(cats)
    log_panel = build_log_panel(log)

    layout = Layout()
    layout.split_column(
        Layout(header, size=3),
        Layout(Panel(table, title="[bold]Category Progress[/bold]", border_style="blue")),
        Layout(log_panel, size=16),
    )
    return layout

# ─── subprocess management ───────────────────────────────────────────────────

def stdout_reader(proc, state, line_queue):
    try:
        for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip()
            line_queue.put(line)
    except Exception:
        pass
    finally:
        line_queue.put(None)  # sentinel

# ─── run mode ────────────────────────────────────────────────────────────────

def run_dashboard(concurrency=3):
    if not NODE_SCRIPT.exists():
        console.print(f"[red]Not found: {NODE_SCRIPT}[/red]")
        sys.exit(1)

    cats_raw = read_categories()
    if not cats_raw:
        console.print("[red]categories.txt is empty. Add URLs first.[/red]")
        sys.exit(1)

    state = RunState()
    # Pre-populate queued state for all categories
    with state.lock:
        for url in cats_raw:
            slug = slug_from_url(url)
            state.categories[slug] = CategoryState(slug, url)

    cmd = ["node", str(NODE_SCRIPT), f"--concurrency={concurrency}"]
    console.print(f"[dim]Launching: {' '.join(cmd)}[/dim]")

    node_proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(SCRIPT_DIR),
    )
    state.node_pid = node_proc.pid

    line_queue = queue.Queue()
    reader_thread = threading.Thread(
        target=stdout_reader, args=(node_proc, state, line_queue), daemon=True
    )
    reader_thread.start()

    def shutdown(sig=None, frame=None):
        console.print("\n[yellow]Stopping node process...[/yellow]")
        try:
            node_proc.send_signal(signal.SIGINT)
        except Exception:
            node_proc.terminate()
        state.finished = True

    signal.signal(signal.SIGINT, shutdown)

    with Live(console=console, refresh_per_second=2, screen=False) as live:
        while True:
            # Drain line queue
            try:
                while True:
                    line = line_queue.get_nowait()
                    if line is None:
                        state.finished = True
                        break
                    parse_line(line, state)
            except queue.Empty:
                pass

            live.update(build_display(state, node_proc))

            if state.finished or node_proc.poll() is not None:
                # Drain remaining lines
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

    node_proc.wait()
    show_status()

# ─── status mode ─────────────────────────────────────────────────────────────

def show_status():
    console.print()
    if not PRODUCT_IDS_DIR.exists():
        console.print("[dim]No product_ids/ directory yet.[/dim]")
        return

    files = sorted(PRODUCT_IDS_DIR.glob("*_ids.json"))
    partials = {f.stem.replace("_ids", ""): f for f in PRODUCT_IDS_DIR.glob("*_ids.partial.json")}

    if not files:
        console.print("[dim]No completed category files.[/dim]")
        return

    table = Table(title="Saved Product ID Files", box=box.SIMPLE_HEAVY, header_style="bold white")
    table.add_column("Category", style="white")
    table.add_column("Products", justify="right")
    table.add_column("Collected At", justify="right", style="dim")
    table.add_column("File", style="dim")

    total = 0
    for f in files:
        if ".partial." in f.name:
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            count = data.get("uniqueCount", len(data.get("products", data.get("ids", []))))
            collected = data.get("collectedAt", "?")[:19].replace("T", " ")
            total += count
            table.add_row(data.get("slug", f.stem), str(count), collected, f.name)
        except Exception as e:
            table.add_row(f.stem, "?", "?", f.name)

    console.print(table)
    console.print(f"[bold]Total: {total} products across {len(files)} categories[/bold]")

    if partials:
        console.print(f"[yellow]{len(partials)} partial file(s): {', '.join(partials.keys())}[/yellow]")

# ─── category manager ────────────────────────────────────────────────────────

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
        table.add_column("#", width=4, justify="right")
        table.add_column("URL", style="cyan")
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

# ─── entry point ─────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    concurrency = 3
    positional = []
    for arg in args:
        if arg.startswith("--concurrency="):
            try:
                concurrency = int(arg.split("=")[1])
            except ValueError:
                pass
        else:
            positional.append(arg)

    cmd = positional[0] if positional else "run"

    if cmd == "categories":
        manage_categories()
    elif cmd == "status":
        show_status()
    elif cmd == "run":
        run_dashboard(concurrency=concurrency)
    else:
        console.print(__doc__)

if __name__ == "__main__":
    main()
