"""在纯白背景上唤出坞，扫描扇形边缘。

抗锯齿像素混的是"底下的颜色"。深色底上看不出来，浅色底上会显成一圈浅边。
这个实验就是为了在可控的浅色背景下复现老板看到的那条边。
"""
import ctypes
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


def find(title):
    hits = []
    P = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _l):
        n = user32.GetWindowTextLengthW(h)
        if n:
            b = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(h, b, n + 1)
            if b.value == title and user32.IsWindow(h):
                hits.append(h)
        return True

    user32.EnumWindows(P(cb), 0)
    return hits[0] if hits else 0


def focus(h):
    if user32.GetForegroundWindow() == h:
        return True
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


def grab(x1, y1, x2, y2):
    w, h = x2 - x1, y2 - y1
    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    gdi32.BitBlt(mem, 0, 0, w, h, hdc, x1, y1, 0x00CC0020 | 0x40000000)

    class BIH(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

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


def main():
    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)

    # 纯白无边框全屏窗口，垫在坞下面
    root = tk.Tk()
    root.overrideredirect(True)
    root.geometry(f"{sw}x{sh}+0+0")
    root.configure(bg="#ffffff")
    root.attributes("-topmost", True)
    root.update()
    root.lift()
    root.update()
    print(f"白色底窗 {sw}x{sh} 已创建")
    time.sleep(0.6)
    root.update()

    # 关掉已有的坞
    # 必须等旧坞真正销毁：open_dock 发现 self.dock 非空时会直接 show 旧窗口，
    # 位置和内容都是上一次的，测出来全是错的
    d = find(DOCK)
    if d:
        user32.PostMessageW(d, 0x0010, 0, 0)
        for _ in range(60):
            time.sleep(0.1)
            if not find(DOCK):
                break
        print(f"旧坞已销毁: {not find(DOCK)}")

    user32.SetCursorPos(900, 500)
    time.sleep(0.3)
    user32.keybd_event(0x12, 0, 0, 0); time.sleep(0.05)
    user32.keybd_event(ord("X"), 0, 0, 0); time.sleep(0.05)
    user32.keybd_event(ord("X"), 0, 2, 0); time.sleep(0.05)
    user32.keybd_event(0x12, 0, 2, 0)

    for _ in range(60):
        time.sleep(0.05)
        d = find(DOCK)
        if d:
            r = wintypes.RECT()
            user32.GetWindowRect(d, ctypes.byref(r))
            if r.right - r.left > 100:
                break
    if not d:
        print("坞没出现")
        root.destroy()
        return 1

    # 这个环境里有程序会动鼠标，坞可能开在屏幕外。直接把窗口挪到固定位置，
    # 窗口区域是窗口坐标，移动不影响"区域 vs SVG"的对应关系。
    SWP_NOZORDER, SWP_NOACTIVATE, SWP_SHOWWINDOW = 0x0004, 0x0010, 0x0040
    user32.SetWindowPos(d, 0, 700, 300, 400, 400,
                        SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
    time.sleep(0.5)
    focus(d)
    time.sleep(1.0)

    rect = wintypes.RECT()
    user32.GetWindowRect(d, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    print(f"坞窗口已固定在 ({rect.left},{rect.top}) {w}x{h}")

    img = grab(rect.left - 10, rect.top - 10, rect.right + 10, rect.bottom + 10)
    img.save(OUT / "white_bg.png")
    print(f"已抓 white_bg.png {img.size}")

    arr = np.asarray(img)
    cx, cy = 10 + w // 2, 10 + h // 2

    print("\n=== 12 点方向半径扫描（白底，看边缘过渡）===")
    prev = None
    for rad in range(60, 200):
        c = arr[cy - rad, cx]
        rgb = (int(c[0]), int(c[1]), int(c[2]))
        if rgb[0] > 240 and rgb[1] > 240 and rgb[2] > 240:
            kind = "白底"
        elif rgb[0] < 40 and rgb[1] < 50 and rgb[2] < 60:
            kind = "扇形"
        else:
            kind = f"过渡 {rgb}"
        if kind != prev:
            print(f"  r={rad:3d}  #{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}  {kind}")
            prev = kind

    print("\n=== 内圈边缘（12 点方向 r=58..76）===")
    for rad in range(58, 77):
        c = arr[cy - rad, cx]
        print(f"  r={rad:3d}  #{c[0]:02x}{c[1]:02x}{c[2]:02x}")

    print("\n=== 扇形之间的间隙（22.5° 方向，应看到白底）===")
    import math
    for k in range(8):
        ang = math.radians(22.5 + k * 45)
        for rad in (100, 140, 170):
            x = cx + int(round(rad * math.sin(ang)))
            y = cy - int(round(rad * math.cos(ang)))
            c = arr[y, x]
            print(f"  {22.5 + k * 45:5.1f}° r={rad:3d}  #{c[0]:02x}{c[1]:02x}{c[2]:02x}")

    print("\n=== 径向边（扇形左右两侧的直边，0° 扇形在 ±20°）===")
    for deg in (-20, -19, -18, 20, 19, 18):
        a = math.radians(deg)
        for rad in (110, 140):
            x = cx + int(round(rad * math.sin(a)))
            y = cy - int(round(rad * math.cos(a)))
            c = arr[y, x]
            print(f"  {deg:+3d}° r={rad:3d}  #{c[0]:02x}{c[1]:02x}{c[2]:02x}")

    # 放大顶部边缘
    img.crop((cx - 100, cy - 200, cx + 100, cy - 150)).resize(
        (800, 200), Image.NEAREST
    ).save(OUT / "white_zoom_top.png")

    user32.PostMessageW(d, 0x0010, 0, 0)
    time.sleep(0.4)
    root.destroy()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
