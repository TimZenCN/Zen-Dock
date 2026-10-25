"""4 背景对比诊断：找出圆环边上那条"底边"。

关键判据：同一条边在 4 种不同桌面背景下
  - 颜色不变  -> 是"画上去的东西"（不透明底色被区域裁出来了）
  - 颜色随背景变 -> 是 alpha 合成/抗锯齿问题
"""
import ctypes
import math
import sys
import time
import tkinter as tk
from ctypes import wintypes
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
k32 = ctypes.windll.kernel32

DOCK = "Zen-Dock 快速启动"
OUT = Path(__file__).resolve().parent
WX, WY = 700, 300
BGS = [("white", "#ffffff"), ("black", "#000000"), ("red", "#ff0000"), ("gray", "#808080")]


def enum_all():
    out = []

    def cb(h, _l):
        n = user32.GetWindowTextLengthW(h)
        b = ctypes.create_unicode_buffer(n + 1) if n else None
        if b:
            user32.GetWindowTextW(h, b, n + 1)
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(h, cls, 256)
        out.append((h, b.value if b else "", cls.value))
        return True

    user32.EnumWindows(ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(cb), 0)
    return out


def find(title):
    for h, t, c in enum_all():
        if t == title and user32.IsWindow(h):
            return h
    return 0


def hide_interference():
    saved = []
    for h, t, c in enum_all():
        if c.startswith("Window_Magpie_") or c == "TTVPWindowForm":
            if user32.IsWindowVisible(h):
                user32.ShowWindow(h, 6)
                saved.append(h)
    return saved


def restore(hs):
    for h in hs:
        if user32.IsWindow(h):
            user32.ShowWindow(h, 9)


def grab(x1, y1, x2, y2):
    w, h = x2 - x1, y2 - y1
    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    gdi32.BitBlt(mem, 0, 0, w, h, hdc, x1, y1, 0x00CC0020 | 0x40000000)

    class BIH(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                    ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                    ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                    ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD)]

    bih = BIH()
    bih.biSize = ctypes.sizeof(BIH)
    bih.biWidth = w
    bih.biHeight = -h
    bih.biPlanes = 1
    bih.biBitCount = 32
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bih), 0)
    arr = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4)[:, :, :3]
    img = Image.fromarray(arr[:, :, ::-1])
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, hdc)
    return img


def focus(h):
    fg = user32.GetForegroundWindow()
    ft = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    cur = k32.GetCurrentThreadId()
    at = False
    if ft and ft != cur:
        at = bool(user32.AttachThreadInput(cur, ft, True))
    try:
        user32.BringWindowToTop(h)
        user32.SetForegroundWindow(h)
    finally:
        if at:
            user32.AttachThreadInput(cur, ft, False)
    return user32.GetForegroundWindow() == h


def kill_dock():
    d = find(DOCK)
    if d:
        user32.PostMessageW(d, 0x0010, 0, 0)
        for _ in range(80):
            time.sleep(0.05)
            if not find(DOCK):
                return True
    return not find(DOCK)


def open_dock():
    kill_dock()
    user32.keybd_event(0x12, 0, 0, 0); time.sleep(0.05)
    user32.keybd_event(ord("X"), 0, 0, 0); time.sleep(0.05)
    user32.keybd_event(ord("X"), 0, 2, 0); time.sleep(0.05)
    user32.keybd_event(0x12, 0, 2, 0)
    for _ in range(80):
        time.sleep(0.05)
        d = find(DOCK)
        if d:
            r = wintypes.RECT()
            user32.GetWindowRect(d, ctypes.byref(r))
            if r.right - r.left > 100:
                return d
    return 0


def px(arr, ox, oy, x, y):
    c = arr[int(round(y)) - oy, int(round(x)) - ox]
    return (int(c[0]), int(c[1]), int(c[2]))


def hx(c):
    return "#%02x%02x%02x" % c


def main():
    print("屏幕", user32.GetSystemMetrics(0), "x", user32.GetSystemMetrics(1))
    saved = hide_interference()
    print("已最小化干扰窗口:", saved)

    results = {}
    rects = {}
    try:
        for name, bg in BGS:
            root = tk.Tk()
            root.overrideredirect(True)
            sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
            root.geometry(f"{sw}x{sh}+0+0")
            root.configure(bg=bg)
            c = tk.Canvas(root, bg=bg, highlightthickness=0, bd=0)
            c.pack(fill="both", expand=True)
            root.attributes("-topmost", True)
            root.update()
            time.sleep(0.5)
            root.update()

            d = open_dock()
            if not d:
                print(f"[{name}] 坞没出现")
                root.destroy()
                continue
            user32.SetWindowPos(d, 0, WX, WY, 400, 400, 0x0004 | 0x0010 | 0x0040)
            time.sleep(0.4)
            focus(d)
            time.sleep(1.2)
            root.update()

            r = wintypes.RECT()
            user32.GetWindowRect(d, ctypes.byref(r))
            rects[name] = (r.left, r.top, r.right - r.left, r.bottom - r.top)
            print(f"[{name}] 坞 {r.left},{r.top} {r.right-r.left}x{r.bottom-r.top}")

            img = grab(r.left - 15, r.top - 15, r.right + 15, r.bottom + 15)
            img.save(OUT / f"edge_{name}.png")
            results[name] = np.asarray(img)
            root.destroy()
            time.sleep(0.3)
    finally:
        restore(saved)

    ox, oy = WX - 15, WY - 15
    w, h = 400, 400
    cx, cy = WX + w // 2, WY + h // 2

    print("\n" + "=" * 78)
    print("A. 12 点方向（home 扇区，fill=#141c28）径向序列 r=56..72 / 178..192")
    print("=" * 78)
    print(" r   " + "".join(f"{n:>11}" for n, _ in BGS))
    for rad in list(range(56, 73)) + list(range(178, 193)):
        row = f"{rad:3d}  "
        for n, _ in BGS:
            if n not in results:
                continue
            row += f"{hx(px(results[n], ox, oy, cx, cy - rad)):>11}"
        print(row)

    print("\n" + "=" * 78)
    print("B. 同一条边在 4 背景下的颜色（判断是否随背景变）")
    print("=" * 78)
    probes = [("内弧带 r=65", 65, 0), ("内弧带 r=66", 66, 0),
              ("外弧带 r=184", 184, 0), ("外弧带 r=185", 185, 0),
              ("外弧带 r=186", 186, 0), ("间隙 22.5° r=125", 125, 22.5),
              ("径向边 20° r=125", 125, 20), ("圆心 r=0", 0, 0)]
    print(f"{'探针':<18}" + "".join(f"{n:>11}" for n, _ in BGS) + "   是否随背景变")
    for label, rad, deg in probes:
        a = math.radians(deg)
        x = cx + rad * math.sin(a)
        y = cy - rad * math.cos(a)
        cols = [px(results[n], ox, oy, x, y) for n, _ in BGS if n in results]
        same = len(set(cols)) == 1
        print(f"{label:<18}" + "".join(f"{hx(c):>11}" for c in cols) + f"   {'否(固定)' if same else '是'}")

    print("\n" + "=" * 78)
    print("C. 8 个扇区中轴线上 内边/外边 的异常带（扫描 r=55..75, 180..190）")
    print("=" * 78)
    for k in range(8):
        mid = k * 45
        a = math.radians(mid)
        for name in [n for n, _ in BGS][:1]:
            if name not in results:
                continue
            seg = []
            for rad in list(range(58, 72)) + list(range(180, 190)):
                x = cx + rad * math.sin(a)
                y = cy - rad * math.cos(a)
                seg.append((rad, px(results[name], ox, oy, x, y)))
            # 找出既不是纯背景也不是扇形色的过渡像素
            print(f"  {mid:3d}° " + " ".join(f"{r}:{hx(c)}" for r, c in seg))

    print("\n" + "=" * 78)
    print("D. 异常带宽度测量（12 点方向，白底）：找出既非白底也非扇形色的连续段")
    print("=" * 78)
    if "white" in results:
        arr = results["white"]
        runs = []
        cur = []
        for rad in range(40, 200):
            c = px(arr, ox, oy, cx, cy - rad)
            is_bg = min(c) > 245
            is_sector = c[0] < 40 and c[1] < 50 and c[2] < 60
            if not is_bg and not is_sector:
                cur.append((rad, c))
            else:
                if cur:
                    runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        for run in runs:
            print(f"  过渡段 r={run[0][0]}..{run[-1][0]} 宽 {len(run)}px")
            for rad, c in run:
                print(f"      r={rad:3d} {hx(c)}")


if __name__ == "__main__":
    main()
