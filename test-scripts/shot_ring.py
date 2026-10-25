"""从屏幕 DC 直接 BitBlt 抓圆环窗口的最终合成像素。

ImageGrab 和 PrintWindow 在透明窗口上都不可靠（前者合成错、后者透明处填白），
从屏幕 DC 拷才是用户实际看到的画面。
"""
import ctypes
import sys
import time
from ctypes import wintypes
from pathlib import Path

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


def grab_screen(x1, y1, x2, y2, path):
    w, h = x2 - x1, y2 - y1
    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    # SRCCOPY | CAPTUREBLT
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
    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    img.save(path)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, hdc)
    return img


def main():
    d = find(DOCK)
    if d:
        user32.PostMessageW(d, 0x0010, 0, 0)
        time.sleep(0.9)

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
        return 1

    focus(d)
    time.sleep(0.9)  # 等扩散动画播完

    r = wintypes.RECT()
    user32.GetWindowRect(d, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    print(f"坞窗口 ({r.left},{r.top}) {w}x{h}")

    # 多抓 20px 边距，方便对比窗口外的桌面
    pad = 20
    img = grab_screen(r.left - pad, r.top - pad, r.right + pad, r.bottom + pad,
                      str(OUT / "ring_screen.png"))
    print(f"已抓 {img.size[0]}x{img.size[1]} → ring_screen.png")

    # 放左上角的 1/4 区域，看边缘细节
    img.crop((0, 0, img.size[0] // 2, img.size[1] // 2)).resize(
        (img.size[0], img.size[1]), Image.NEAREST
    ).save(OUT / "ring_zoom_tl.png")

    # 扇形外弧边界：12 点方向
    px = img.load()
    cx, cy = pad + w // 2, pad + h // 2
    print("\n12 点方向，从扇形内往外（窗口坐标 r 以 400 为基准）:")
    scale = min(w, h) / 400.0
    for rad in range(170, 200):
        x, y = cx, cy - int(round(rad * scale))
        if 0 <= y < img.size[1]:
            c = px[x, y]
            print(f"  r={rad:3d} (y={y - pad:3d})  #{c[0]:02x}{c[1]:02x}{c[2]:02x}")

    print("\n内圈边缘（12 点方向，r=60..72）:")
    for rad in range(58, 74):
        x, y = cx, cy - int(round(rad * scale))
        c = px[x, y]
        print(f"  r={rad:3d} (y={y - pad:3d})  #{c[0]:02x}{c[1]:02x}{c[2]:02x}")

    user32.PostMessageW(d, 0x0010, 0, 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
