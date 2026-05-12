#!/usr/bin/env python3
"""Run: python3 trendyol/_test_keys.py  — press arrow keys, q to quit."""
import os, sys, select as sel, termios, tty

fd  = sys.stdin.fileno()
old = termios.tcgetattr(fd)
print("Press arrow keys, Enter, letters. Q to quit.")
try:
    tty.setcbreak(fd)
    while True:
        r, _, _ = sel.select([fd], [], [], 5)
        if not r:
            print("(timeout)")
            continue
        ch = os.read(fd, 1)
        if ch == b"\x1b":
            r2, _, _ = sel.select([fd], [], [], 0.15)
            if r2:
                ch2 = os.read(fd, 1)
                if ch2 == b"[":
                    r3, _, _ = sel.select([fd], [], [], 0.15)
                    if r3:
                        ch3 = os.read(fd, 1)
                        name = {b"A":"UP", b"B":"DOWN", b"C":"RIGHT", b"D":"LEFT"}.get(ch3, f"ESC[{ch3}]")
                        print(f"KEY: {name}")
                        continue
            print("KEY: ESC")
        elif ch in (b"\r", b"\n"):
            print("KEY: ENTER")
        elif ch == b"q":
            print("bye"); break
        else:
            print(f"KEY: {ch.decode('ascii','replace')!r}")
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
