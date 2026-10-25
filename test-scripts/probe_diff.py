"""差分法：唤出坞前后各抓一次屏幕，差异区域就是坞真正影响的范围。

这样能干净地回答一个问题：坞在屏幕上到底占了多大一块？
如果差异是个 400x400 的矩形（哪怕很淡），说明有窗口级的东西在绘制；
如果差异只有扇形，说明窗口是真的透明。
"""
import ctypes
import sys
import time
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

# 坞窗口会是 400x400、鼠标居中，所以抓鼠标周围 500x500 一定包住
PAD = 250


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
    d = find(DOCK)
    if d:
        user32.PostMessageW(d, 0x0010, 0, 0)
        time.sleep(1.0)

    user32.SetCursorPos(900, 500)
    time.sleep(0.5)

    x1, y1 = 900 - PAD, 500 - PAD
    x2, y2 = 900 + PAD, 500 + PAD

    print("抓唤出前的背景…")
    before = grab(x1, y1, x2, y2)
    before.save(OUT / "diff_before.png")

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
    time.sleep(1.2)

    print("抓唤出后的画面…")
    after = grab(x1, y1, x2, y2)
    after.save(OUT / "diff_after.png")

    a = np.asarray(before, dtype=np.int16)
    b = np.asarray(after, dtype=np.int16)
    diff = np.abs(a - b).sum(axis=2)

    print(f"\n差分统计：最大 {diff.max()}  平均 {diff.mean():.2f}")
    for thr in (0, 2, 4, 8, 16, 32):
        n = int((diff > thr).sum())
        print(f"  差值 > {thr:2d} 的像素数: {n:6d}  ({n / diff.size * 100:.1f}%)")

    # 用阈值 4 找出"确实有变化"的区域
    mask = diff > 4
    ys, xs = np.where(mask)
    if len(xs):
        print(f"\n变化区域包围盒（图像坐标，原点 {x1},{y1}）: "
              f"x {xs.min()}..{xs.max()}  y {ys.min()}..{ys.max()}")
        print(f"  即屏幕坐标 ({x1 + xs.min()},{y1 + ys.min()})-"
              f"({x1 + xs.max()},{y1 + ys.max()})")

    # 输出可视化：变化的像素标红
    vis = np.asarray(after).copy()
    vis[mask] = [255, 0, 0]
    Image.fromarray(vis).save(OUT / "diff_mask.png")

    # 单独输出"微弱变化"（2 < diff <= 8）——边框/阴影这种淡的东西会在这里
    weak = (diff > 1) & (diff <= 8)
    vis2 = np.asarray(after).copy()
    vis2[weak] = [0, 255, 0]
    Image.fromarray(vis2).save(OUT / "diff_weak.png")
    print(f"微弱变化（1 < diff <= 8）像素数: {int(weak.sum())}")

    # 窗口矩形四条边内侧 6px 的差值和中心对比
    print("\n=== 窗口矩形边缘 vs 中心 的差值 ===")
    # 坞窗口在 (700,300)-(1100,700) → 图像坐标 (450,50)-(850,450)
    wx1, wy1 = 700 - x1, 300 - y1
    wx2, wy2 = 1100 - x1, 700 - y1
    print(f"  窗口在图中 ({wx1},{wy1})-({wx2},{wy2})")
    edges = {
        "上边 3px 内": diff[wy1 + 1:wy1 + 4, wx1 + 40:wx2 - 40],
        "下边 3px 内": diff[wy2 - 4:wy2 - 1, wx1 + 40:wx2 - 40],
        "左边 3px 内": diff[wy1 + 40:wy2 - 40, wx1 + 1:wx1 + 4],
        "右边 3px 内": diff[wy1 + 40:wy2 - 40, wx2 - 4:wx2 - 1],
        "四角区域": np.concatenate([
            diff[wy1:wy1 + 20, wx1:wx1 + 20].ravel(),
            diff[wy1:wy1 + 20, wx2 - 20:wx2].ravel(),
            diff[wy2 - 20:wy2, wx1:wx1 + 20].ravel(),
            diff[wy2 - 20:wy2, wx2 - 20:wx2].ravel(),
        ]),
        "扇形区(上中)": diff[wy1 + 20:wy1 + 60, wx1 + 170:wx1 + 230],
        "圆心": diff[wy1 + 180:wy1 + 220, wx1 + 180:wx1 + 220],
    }
    for k, v in edges.items():
        print(f"  {k:14} 平均 {v.mean():6.2f}  最大 {v.max():3d}  >4的比例 {(v > 4).mean() * 100:5.1f}%")

    user32.PostMessageW(d, 0x0010, 0, 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
