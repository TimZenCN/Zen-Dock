"""不开窗口，只验证圆环的绘制结果：alpha 是不是真的 per-pixel。

关键要验三件事：
1. 扇形内部完全不透明（alpha=255）
2. 扇区之间的间隙 alpha=0（真透明，不是拿深色填的）
3. 扇形边缘有中间 alpha 的过渡带（抗锯齿，不是硬阶梯）

用法：
    .venv\\Scripts\\python.exe test-scripts/probe_ring_draw.py [端口]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shell"))

import ring  # noqa: E402

OUT = Path(__file__).resolve().parent / "ring-draw.png"


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7717

    dock = ring.RingDock(port=port)
    dock._slots = ring.build_slots(port)
    dock._count = len(dock._slots)
    dock._scale = 1.0
    dock._w = dock._h = ring.RING_W
    dock._phase = "idle"
    dock._hover = -1
    dock.hwnd = 1            # 让 _render 不因为"没窗口"直接返回
    dock._commit = lambda alpha=1.0: None  # 不提交到窗口，只留位图

    print(f"槽位 {dock._count} 个：")
    for s in dock._slots:
        print(f"  {s.id:16s} kind={s.kind:8s} status={s.status or '-':10s} name={s.name}")

    dock._ensure_surface()
    dock._render()

    from System.Drawing.Imaging import ImageFormat

    dock._bitmap.Save(str(OUT), ImageFormat.Png)

    # 逐点验 alpha
    from PIL import Image

    im = Image.open(OUT).convert("RGBA")
    w, h = im.size
    print(f"\n位图 {w}x{h} → {OUT}")

    step = 360.0 / max(1, dock._count)
    half = min(step / 2 - 2.5, ring.MAX_HALF)
    import math

    def at(r, deg):
        a = math.radians(deg)
        return int(round(ring.CX + r * math.sin(a))), int(round(ring.CY - r * math.cos(a)))

    print("\n--- 每块扇形的中心（r=125, 正中）---")
    for i in range(dock._count):
        mid = i * step
        xy = at(ring.CONTENT_R, mid)
        print(f"  块{i} 角度{mid:5.1f}° {xy} -> {im.getpixel(xy)}")

    print("\n--- 扇区之间的间隙（角度 = 两块中间，r=125）---")
    gaps = []
    for i in range(dock._count):
        mid = i * step + step / 2
        xy = at(ring.CONTENT_R, mid)
        px = im.getpixel(xy)
        gaps.append(px[3])
        print(f"  间隙{i} 角度{mid:5.1f}° {xy} -> {px}")

    print("\n--- 窗口四角（应完全透明）---")
    for xy in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)):
        print(f"  {xy} -> {im.getpixel(xy)}")

    print("\n--- 扇形外缘抗锯齿带（块0 正中，r 从 182 到 187）---")
    mid0 = 0.0
    band = []
    for r in range(180, 189):
        xy = at(r, mid0)
        px = im.getpixel(xy)
        band.append(px[3])
        print(f"  r={r} {xy} -> {px}")

    # 判定
    ok = True
    center_alphas = [im.getpixel(at(ring.CONTENT_R, i * step))[3] for i in range(dock._count)]
    if min(center_alphas) < 250:
        print(f"\n✗ 扇形内部不够实：{center_alphas}")
        ok = False
    if max(gaps) > 8:
        print(f"\n✗ 间隙不够透明：{gaps}")
        ok = False
    if not any(0 < a < 250 for a in band):
        print(f"\n✗ 外缘没有抗锯齿过渡带：{band}")
        ok = False

    print("\n" + ("✓ 三项全过：内部实、间隙真透明、边缘有抗锯齿" if ok else "✗ 有问题，见上"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
