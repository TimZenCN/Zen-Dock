"""量出 SetWindowRgn 的实际边界，跟 SVG 扇形边界对比。

PtInRegion 直接问系统"这个点在不在窗口区域里"，不受绘制影响，
能干净地区分"区域错了"和"绘制错了"。
"""
import ctypes
import sys
import time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
k32 = ctypes.windll.kernel32

DOCK = "Zen-Dock 快速启动"


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
    time.sleep(1.0)

    rect = wintypes.RECT()
    user32.GetWindowRect(d, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    print(f"窗口 ({rect.left},{rect.top}) {w}x{h}")

    # 取回区域
    rgn = gdi32.CreateRectRgn(0, 0, 0, 0)
    kind = user32.GetWindowRgn(d, rgn)
    print(f"GetWindowRgn 返回 {kind}  (0=ERROR, 1=NULLREGION, 2=SIMPLEREGION, 3=COMPLEXREGION)")

    box = wintypes.RECT()
    gdi32.GetRgnBox(rgn, ctypes.byref(box))
    print(f"区域包围盒 ({box.left},{box.top})-({box.right},{box.bottom})  "
          f"{box.right - box.left}x{box.bottom - box.top}")

    cx, cy = w // 2, h // 2

    def inside(x, y):
        return bool(gdi32.PtInRegion(rgn, x, y))

    print(f"\n沿 8 个方向从圆心往外扫，找区域边界（窗口中心 {cx},{cy}）：")
    import math
    for deg in (0, 45, 90, 135, 180, 225, 270, 315):
        a = math.radians(deg)
        last_in = -1
        for rad in range(0, 205):
            x = cx + int(round(rad * math.sin(a)))
            y = cy - int(round(rad * math.cos(a)))
            if 0 <= x < w and 0 <= y < h and inside(x, y):
                last_in = rad
        print(f"  {deg:3d}°  区域最远 r={last_in}")

    print("\n沿 12 点方向逐像素看内外边界：")
    prev = None
    for rad in range(0, 205):
        y = cy - rad
        if not (0 <= y < h):
            break
        cur = inside(cx, y)
        if cur != prev:
            print(f"  r={rad:3d}  {'进入区域' if cur else '离开区域'}")
            prev = cur

    print("\n窗口四边中点是否在区域内（应该 False，因为扇形不到边）：")
    for label, (x, y) in [
        ("上", (cx, 0)), ("下", (cx, h - 1)),
        ("左", (0, cy)), ("右", (w - 1, cy)),
        ("左上", (2, 2)), ("右下", (w - 3, h - 3)),
    ]:
        print(f"  {label:4} ({x},{y})  {'在区域内 ⚠' if inside(x, y) else '在区域外 ✓'}")

    gdi32.DeleteObject(rgn)
    user32.PostMessageW(d, 0x0010, 0, 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
