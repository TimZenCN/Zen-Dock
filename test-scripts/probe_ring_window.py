"""不开窗验证整条 Win32 链路：注册类 → CreateWindowEx → SetWindowRgn →
GDI+ 绘制 → UpdateLayeredWindow。窗口全程隐藏，不打扰桌面。

用法：
    .venv\\Scripts\\python.exe test-scripts/probe_ring_window.py [端口]
"""

from __future__ import annotations

import ctypes
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shell"))

import ring  # noqa: E402


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7717
    user32 = ring.user32

    # 模拟外壳启动时的后台预热，这样首帧耗时不掺 GDI+ 冷加载
    ring._load_gdip()

    dock = ring.RingDock(port=port)
    dock.visible = False  # 只跑链路，不显示
    dock.show()

    hwnd = 0
    for _ in range(80):
        time.sleep(0.05)
        hwnd = dock.hwnd
        if hwnd:
            break
    if not hwnd:
        print("✗ 窗口没建出来")
        return 1

    print(f"✓ 窗口句柄 {hwnd}")

    # 窗口风格：必须是 WS_EX_LAYERED，否则 UpdateLayeredWindow 会失败
    GWL_EXSTYLE = -20
    user32.GetWindowLongW.argtypes = [ring.wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    layered = bool(ex & ring.WS_EX_LAYERED)
    topmost = bool(ex & ring.WS_EX_TOPMOST)
    tool = bool(ex & ring.WS_EX_TOOLWINDOW)
    print(f"  WS_EX_LAYERED  = {layered}   ← 必须是 True")
    print(f"  WS_EX_TOPMOST  = {topmost}")
    print(f"  WS_EX_TOOLWINDOW = {tool}   ← 不进 Alt+Tab")

    # 命中区域：GetWindowRgn 返回 3 (COMPLEXREGION) 说明扇形并集生效
    rgn = ring.gdi32.CreateRectRgn(0, 0, 0, 0)
    kind = user32.GetWindowRgn(hwnd, rgn)
    ring.gdi32.DeleteObject(rgn)
    print(f"  命中区域类型 = {kind}   (1=空 2=矩形 3=复杂)   ← 3 才对，说明扇形并集生效")

    # 位置与尺寸
    r = ring.wintypes.RECT()
    user32.GetWindowRect(hwnd, ring.ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    print(f"  窗口矩形 ({r.left},{r.top}) {w}x{h}  scale={dock._scale:.2f}")

    pt = ring.wintypes.POINT()
    user32.GetCursorPos(ring.ctypes.byref(pt))
    cx, cy = r.left + w // 2, r.top + h // 2
    print(f"  圆心 ({cx},{cy}) 鼠标 ({pt.x},{pt.y}) 偏差 ({cx - pt.x},{cy - pt.y})")

    # 动画跑完没有
    time.sleep(0.8)
    print(f"  首轮动画阶段 = {dock._phase}  (应为 idle)")

    # 复用路径：hide → show，看第二次起唤出多快
    dock.close(animated=False)
    time.sleep(0.35)
    print(f"  隐藏后 _shown = {dock._shown}  句柄仍在 = {bool(dock.hwnd)}")

    for round_no in (1, 2, 3):
        t0 = time.perf_counter()
        dock.show()
        for _ in range(200):
            time.sleep(0.005)
            if dock._shown:
                break
        print(f"  第{round_no}次复用唤出 {int((time.perf_counter() - t0) * 1000)}ms  _shown={dock._shown}")
        dock.close(animated=False)
        time.sleep(0.3)

    # 重新查一次区域 —— 复用几轮之后区域可能被 apply_hit_region 重设过，
    # 用旧变量判断会读到过期值。
    rgn2 = ring.gdi32.CreateRectRgn(0, 0, 0, 0)
    kind_now = user32.GetWindowRgn(hwnd, rgn2)
    ring.gdi32.DeleteObject(rgn2)
    ok = bool(layered) and kind_now == 3
    print(f"  判定: layered={layered} 区域(首次)={kind} 区域(现在)={kind_now} ok={ok}")
    dock.destroy()
    time.sleep(0.5)
    print(f"  销毁后句柄 = {dock.hwnd}  (应为 0)")

    print("\n" + ("✓ 链路全通" if ok else "✗ 有问题，见上"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
