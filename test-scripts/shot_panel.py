"""截取桌面外壳的主窗口（或拓展坞）画面，用来肉眼核对视觉。

用法：
    .venv\\Scripts\\python.exe test-scripts/shot_panel.py            # 主窗口
    .venv\\Scripts\\python.exe test-scripts/shot_panel.py dock       # 拓展坞

为什么不用 PowerShell 的 Add-Type：会被安全策略拦掉（运行期编译 .NET）。
Pillow 本来就在依赖里（pystray 带的），直接 ImageGrab 更省事。
"""

from __future__ import annotations

import ctypes
import sys
import time
from ctypes import wintypes
from pathlib import Path

from PIL import ImageGrab

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test-scripts"
SW_RESTORE = 9

TITLES = {"main": "Zen-Dock", "dock": "Zen-Dock 快速启动"}

user32 = ctypes.windll.user32


def find_window(title: str) -> int:
    return user32.FindWindowW(None, title)


def main() -> int:
    which = (sys.argv[1] if len(sys.argv) > 1 else "main").lower()
    title = TITLES.get(which, TITLES["main"])
    hwnd = find_window(title)
    if not hwnd:
        print(f"找不到窗口：{title}")
        return 1

    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.8)  # 等动画/重绘落定

    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    box = (rect.left, rect.top, rect.right, rect.bottom)
    w, h = rect.right - rect.left, rect.bottom - rect.top
    print(f"窗口 {title} @ {rect.left},{rect.top} {w}x{h}")

    img = ImageGrab.grab(bbox=box, all_screens=True)
    path = OUT / f"{which}-shot.png"
    img.save(path)
    print(f"已保存 {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
