"""验证「该透明的地方真的透明」—— 用屏幕像素做前后对比。

这是唯一靠得住的判定方法。之前的差分法只能证明"区域外没绘制"，证明不了
"区域内是透明的"：只要窗口在形状内铺了任何实色，屏幕像素照样会变。

做法：
1. 窗口隐藏时，截一块屏幕 → before
2. 显示圆环，等动画跑完，截同一块 → after
3. 扇区之间的间隙、环心空洞：before 和 after 必须**逐像素相同**（透出壁纸）
   扇形内部：必须不同（那里画了 UI）

窗口固定在屏幕左上角，不跟鼠标，避免打断正在用电脑的人。

用法：
    .venv\\Scripts\\python.exe test-scripts/probe_ring_transparent.py [端口]
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shell"))

import ring  # noqa: E402
from PIL import ImageGrab  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent
WIN_X, WIN_Y = 60, 60
PAD = 8  # 截图时往外多留一点，能看到窗口边界


def grab(x, y, w, h):
    return ImageGrab.grab(bbox=(x - PAD, y - PAD, x + w + PAD, y + h + PAD), all_screens=True).convert("RGB")


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7717
    ring._load_gdip()

    dock = ring.RingDock(port=port)
    dock.pos_override = (WIN_X, WIN_Y)
    dock.visible = False  # 先建窗口但不显示，拿到一张"窗口不存在"的底图
    dock.show()

    for _ in range(120):
        time.sleep(0.05)
        if dock.hwnd:
            break
    if not dock.hwnd:
        print("✗ 窗口没建出来")
        return 1
    time.sleep(0.3)

    w, h = dock._w, dock._h
    before = grab(WIN_X, WIN_Y, w, h)
    before.save(OUT_DIR / "trans-before.png")

    dock.show()  # 复用唤出，这次会真的显示
    time.sleep(0.9)  # 等 bloom（515ms）跑完
    after = grab(WIN_X, WIN_Y, w, h)
    after.save(OUT_DIR / "trans-after.png")

    # 再截一张"窗口已隐藏"的，间隔只有 150ms，背景几乎不可能变。
    # 该透明的地方，两张图必须逐像素相同 —— 这个判据不依赖背景是什么颜色，
    # 比"颜色是否等于扇色"可靠（背景可能恰好接近扇色，也可能正好是纯色）。
    dock.close(animated=False)
    time.sleep(0.15)
    gone = grab(WIN_X, WIN_Y, w, h)
    gone.save(OUT_DIR / "trans-gone.png")
    dock.destroy()

    # ---- 逐点对比 ----
    import math

    step = 360.0 / max(1, dock._count)
    half = min(step / 2 - 2.5, ring.MAX_HALF)

    def at(r, deg):
        """逻辑坐标 → 截图坐标（截图左上角比窗口左上角多出 PAD）"""
        a = math.radians(deg)
        return (
            int(round(PAD + ring.CX + r * math.sin(a))),
            int(round(PAD + ring.CY - r * math.cos(a))),
        )

    print(f"\n窗口 {w}x{h} @({WIN_X},{WIN_Y})，{dock._count} 块扇形\n")

    # 判据：窗口显示时（after）和刚隐藏后（gone）逐像素对比。
    # 该透明的地方两者必须完全相同；扇形内部必须不同（那里画了东西）。
    # 不依赖背景颜色，也不依赖"背景在前后没变"这个假设。
    def same(xy):
        return after.getpixel(xy) == gone.getpixel(xy)

    def at2(cx, cy, radius, n=24):
        out = []
        for i in range(n):
            ang = i * (360.0 / n)
            rr = radius * (0.35 + 0.65 * (i % 3) / 2.0)
            a = math.radians(ang)
            x = int(round(PAD + cx + rr * math.sin(a)))
            y = int(round(PAD + cy - rr * math.cos(a)))
            if 0 <= x < after.width and 0 <= y < after.height:
                out.append((x, y))
        return out

    print("--- 环心空洞（该透明：与隐藏后完全一致）---")
    pts = at2(ring.CX, ring.CY, 50)
    bad = [xy for xy in pts if not same(xy)]
    hole_ok = not bad
    print(f"  环心 {len(pts)} 点：{'全部透出背景' if hole_ok else f'{len(bad)} 点不透 {bad[:4]}'}")

    print("\n--- 窗口四角（该透明）---")
    corner_ok = True
    for name, (cx, cy) in (("左上", (18, 18)), ("右上", (w - 18, 18)), ("左下", (18, h - 18)), ("右下", (w - 18, h - 18))):
        ps = at2(cx, cy, 12, 12)
        b = [xy for xy in ps if not same(xy)]
        ok = not b
        corner_ok = corner_ok and ok
        print(f"  {name}：{len(ps) - len(b)}/{len(ps)} 透 {'✓' if ok else '★'}")

    print("\n--- 扇区之间的间隙（该透明）---")
    gap_ok = True
    for i in range(dock._count):
        mid = i * step + step / 2
        xy = at(ring.CONTENT_R, mid)
        ok = same(xy)
        gap_ok = gap_ok and ok
        print(f"  间隙{i} 角度{mid:5.1f}° {xy} 显示{after.getpixel(xy)} 隐藏{gone.getpixel(xy)} {'透' if ok else '★不透'}")

    print("\n--- 扇形内部（必须有内容：与隐藏后不同）---")
    solid_ok = True
    for i in range(dock._count):
        xy = at(ring.CONTENT_R, i * step)
        px = after.getpixel(xy)
        ok = not same(xy) and max(abs(px[k] - (22, 27, 38)[k]) for k in range(3)) <= 14
        solid_ok = solid_ok and ok
        print(f"  块{i} {xy} {px} {'扇色 ✓' if ok else '★异常'}")

    ok = hole_ok and corner_ok and gap_ok and solid_ok
    print("\n" + ("✓ 真透明：环心/四角/间隙与隐藏后完全一致，扇形内部有内容" if ok else "✗ 还有地方没真透明"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
