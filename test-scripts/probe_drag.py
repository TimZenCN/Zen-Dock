"""验证标题栏拖动真的能移动窗口。

会真的动鼠标：移过去 → 按下 → 分十步拖 80x50 → 松开 → 量窗口位置。
跑之前确保没在干别的（鼠标会被抢走一秒）。

用法：
    .venv\\Scripts\\python.exe test-scripts/probe_drag.py
    .venv\\Scripts\\python.exe test-scripts/probe_drag.py 120 60   # 自定义位移
"""

from __future__ import annotations

import ctypes
import sys
import time
from ctypes import wintypes

user32 = ctypes.windll.user32

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_MOVE = 0x0001

TITLE = "Zen-Dock"


def rect_of(hwnd: int) -> tuple[int, int, int, int]:
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def main() -> int:
    dx = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    dy = int(sys.argv[2]) if len(sys.argv) > 2 else 50

    hwnd = user32.FindWindowW(None, TITLE)
    if not hwnd:
        print(f"找不到窗口：{TITLE}")
        return 1

    # 必须先激活。点后台窗口的第一次点击会被系统拿去"激活"，内容收不到。
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.5)
    if user32.GetForegroundWindow() != hwnd:
        print("警告：没能把窗口拉到前台，测试结果可能不准")

    x0, y0, x1, y1 = rect_of(hwnd)
    print(f"窗口初始 ({x0},{y0}) {x1 - x0}x{y1 - y0}")

    # 标题栏左侧空白区（避开 brand 文字和右侧按钮）
    px = x0 + 260
    py = y0 + 18
    print(f"在 ({px},{py}) 按下，拖 ({dx},{dy})")

    user32.SetCursorPos(px, py)
    time.sleep(0.2)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.12)

    steps = 10
    for i in range(1, steps + 1):
        user32.SetCursorPos(px + dx * i // steps, py + dy * i // steps)
        time.sleep(0.025)
    time.sleep(0.12)

    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(0.35)

    nx0, ny0, _, _ = rect_of(hwnd)
    moved_x, moved_y = nx0 - x0, ny0 - y0
    print(f"窗口现在 ({nx0},{ny0})，位移 ({moved_x},{moved_y})")

    ok = abs(moved_x - dx) <= 6 and abs(moved_y - dy) <= 6
    print("结果:", "ok  拖动生效" if ok else "FAIL 窗口没跟着动（或位移不对）")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
