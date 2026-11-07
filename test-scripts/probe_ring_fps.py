"""圆环坞帧率回归：真实显示窗口，连测三轮复用唤出。

只统计入场动画的帧数与每帧耗时，不截图、不碰鼠标。
用法：.venv/Scripts/python.exe test-scripts/probe_ring_fps.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shell"))
import ring


def wait(pred, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def main() -> int:
    dock = ring.RingDock(port=7717)
    dock.visible = False  # 先建窗口+预热 GDI+，不显示
    dock.show()
    if not wait(lambda: bool(dock.hwnd)):
        print("✗ 窗口没建出来")
        return 1

    dock.visible = True
    results = []
    for i in range(3):
        dock.show()
        if not wait(lambda: dock._shown and dock._phase != "idle", 2.0) or not wait(
            lambda: dock._phase == "idle", 3.0
        ):
            print(f"✗ 第 {i + 1} 轮动画没跑完（phase={dock._phase}）")
            dock.destroy()
            return 1
        time.sleep(0.05)
        frames = list(dock._frames)
        if not frames:
            print(f"✗ 第 {i + 1} 轮没采集到帧")
            dock.destroy()
            return 1
        avg = sum(frames) / len(frames) * 1000
        worst = max(frames) * 1000
        results.append(len(frames))
        print(
            f"  第 {i + 1} 轮：{len(frames):2d} 帧  "
            f"平均 {avg:.1f}ms  最慢 {worst:.1f}ms  "
            f"入场 {dock.bloom_ms}ms + 错峰 {dock.stagger_ms}ms"
        )
        dock.close(animated=False)
        wait(lambda: not dock._shown, 1.0)
        time.sleep(0.15)

    dock.destroy()
    wait(lambda: not dock.hwnd, 1.0)

    lo = min(results)
    spread = max(results) - lo
    expect = (dock.bloom_ms + dock.stagger_ms * 7) / ring.FRAME_MS
    print(f"\n最少 {lo} 帧 / 期望约 {expect:.0f} 帧 / 三轮波动 {spread} 帧")
    # DWM 合成是硬上限，能稳定拿到理论值的 70% 且三轮波动 ≤5 帧就算合格。
    # 改造前是 9 / 21 / 22 帧，波动 13 帧 —— 不稳定才是问题。
    ok = lo >= expect * 0.7 and spread <= 5
    print("✓ 帧率稳定" if ok else "✗ 仍有明显掉帧")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
