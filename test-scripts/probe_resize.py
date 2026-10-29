"""验证右下角缩放真的能改窗口尺寸。

会真的动鼠标（按下 → 拖 → 松开）。和 probe_drag 是同一套路，
只是抓的是右下角的 se 热区。

用法：
    .venv\\Scripts\\python.exe test-scripts/probe_resize.py
    .venv\\Scripts\\python.exe test-scripts/probe_resize.py -120 -80   # 缩小
"""

from __future__ import annotations

import ctypes
import sys
import time
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004

TITLE = "Zen-Dock"
SW_RESTORE = 9
SWP_NOZORDER = 0x0004


def force_foreground(hwnd: int) -> bool:
    """绕过前台锁把窗口拉到最前。

    直接 SetForegroundWindow 会被系统挡住（只有当前前台进程才有权改前台），
    标准绕法是先 AttachThreadInput 挂到前台线程的输入队列上。
    """
    if user32.GetForegroundWindow() == hwnd:
        return True
    fg = user32.GetForegroundWindow()
    fg_thread = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    cur = kernel32.GetCurrentThreadId()
    attached = False
    if fg_thread and fg_thread != cur:
        attached = bool(user32.AttachThreadInput(cur, fg_thread, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(cur, fg_thread, False)
    return user32.GetForegroundWindow() == hwnd


def rect_of(hwnd: int) -> tuple[int, int, int, int]:
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def main() -> int:
    dx = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    dy = int(sys.argv[2]) if len(sys.argv) > 2 else 80

    hwnd = user32.FindWindowW(None, TITLE)
    if not hwnd:
        print(f"找不到窗口：{TITLE}")
        return 1

    user32.ShowWindow(hwnd, SW_RESTORE)
    if not force_foreground(hwnd):
        print("警告：没能把窗口拉到前台，测试结果可能不准")
    time.sleep(0.6)

    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)
    print(f"屏幕 {sw}x{sh}")

    # 先把窗口挪到左上、缩到能放下，否则右下角可能跑到屏幕外，
    # SetCursorPos 会被系统 clamp 到屏幕边缘，压根点不到 se 热区。
    user32.SetWindowPos(hwnd, 0, 80, 80, 1100, 700, SWP_NOZORDER)
    time.sleep(0.4)

    x0, y0, x1, y1 = rect_of(hwnd)
    print(f"窗口初始 ({x0},{y0}) {x1 - x0}x{y1 - y0}")

    # 右下角 se 热区是 10x10，取角内 4px
    px, py = x1 - 4, y1 - 4
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

    nx0, ny0, nx1, ny1 = rect_of(hwnd)
    print(f"窗口现在 ({nx0},{ny0}) {nx1 - nx0}x{ny1 - ny0}")
    print(f"尺寸变化 ({nx1 - nx0 - (x1 - x0)}, {ny1 - ny0 - (y1 - y0)})，期望 ({dx},{dy})")

    ok = abs((nx1 - nx0) - (x1 - x0) - dx) <= 8 and abs((ny1 - ny0) - (y1 - y0) - dy) <= 8
    print("结果:", "ok  缩放生效" if ok else "FAIL 尺寸没变（或变化不对）")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
