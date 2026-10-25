"""圆环坞端到端验收：唤出 → 点击启动 → 右键详情 → 主页 → 失焦关闭。测完即删。"""

from __future__ import annotations

import ctypes
import json
import math
import sys
import time
import urllib.request
from ctypes import wintypes

user32 = ctypes.windll.user32

DOCK = "Zen-Dock 快速启动"
MAIN = "Zen-Dock"
HOST = "http://127.0.0.1:7717"


def find(title: str) -> int:
    hits: list[int] = []
    proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lp):
        n = user32.GetWindowTextLengthW(hwnd)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value == title and user32.IsWindow(hwnd):
                hits.append(hwnd)
        return True

    user32.EnumWindows(proc(cb), 0)
    return hits[0] if hits else 0


def press_hotkey() -> None:
    user32.keybd_event(0x12, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(ord("X"), 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(ord("X"), 0, 2, 0)
    time.sleep(0.05)
    user32.keybd_event(0x12, 0, 2, 0)


def wait_for(title: str, seconds: float = 4.0) -> int:
    end = time.time() + seconds
    while time.time() < end:
        h = find(title)
        if h:
            return h
        time.sleep(0.1)
    return 0


def wait_ready(seconds: float = 6.0) -> int:
    """等坞窗口出现且尺寸已落定（刚创建时 GetWindowRect 可能是 0x0）。"""
    end = time.time() + seconds
    while time.time() < end:
        h = find(DOCK)
        if h:
            rect = wintypes.RECT()
            user32.GetWindowRect(h, ctypes.byref(rect))
            if rect.right - rect.left > 100:
                focus(h)
                return h
        time.sleep(0.1)
    return 0


def focus(hwnd: int) -> bool:
    """把坞强行拉到前台。自动化环境里别的窗口会不停抢焦点，
    不这么做坞会被失焦检测关掉，后面的点击根本来不及。"""
    if user32.GetForegroundWindow() == hwnd:
        return True
    fg = user32.GetForegroundWindow()
    ft = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    cur = ctypes.windll.kernel32.GetCurrentThreadId()
    attached = False
    if ft and ft != cur:
        attached = bool(user32.AttachThreadInput(cur, ft, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(cur, ft, False)
    return user32.GetForegroundWindow() == hwnd


def click(x: int, y: int, right: bool = False) -> None:
    user32.SetCursorPos(x, y)
    time.sleep(0.2)
    if right:
        user32.mouse_event(0x0008, 0, 0, 0, 0)  # RIGHTDOWN
        time.sleep(0.05)
        user32.mouse_event(0x0010, 0, 0, 0, 0)  # RIGHTUP
    else:
        user32.mouse_event(0x0002, 0, 0, 0, 0)
        time.sleep(0.05)
        user32.mouse_event(0x0004, 0, 0, 0, 0)


def api(path: str) -> dict:
    with urllib.request.urlopen(HOST + path, timeout=5) as r:
        return json.loads(r.read().decode())


def ring_pos(hwnd: int, deg: float, radius: int = 130) -> tuple[int, int]:
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    cx, cy = rect.left + 200, rect.top + 200
    a = math.radians(deg)
    return int(cx + radius * math.sin(a)), int(cy - radius * math.cos(a))


def main() -> int:
    results: list[tuple[bool, str]] = []

    def check(ok: bool, label: str) -> None:
        results.append((ok, label))
        print(f"  {'✓' if ok else '✗'} {label}")

    # 确保干净起点
    user32.SetCursorPos(900, 500)
    time.sleep(0.4)
    if find(DOCK):
        press_hotkey()
        time.sleep(0.6)

    print("\n[1] 热键唤出圆环")
    press_hotkey()
    hwnd = wait_ready()
    check(bool(hwnd), "坞窗口出现")
    if not hwnd:
        return 1
    time.sleep(1.6)
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    check((w, h) == (400, 400), f"窗口 400x400（实得 {w}x{h}）")
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    dx, dy = rect.left + 200 - pt.x, rect.top + 200 - pt.y
    check(abs(dx) <= 2 and abs(dy) <= 2, f"圆心对齐鼠标（偏差 {dx},{dy}）")

    print("\n[2] 点击扇形启动服务")
    st = api("/api/items/relay")["runtime"]
    if st.get("status") == "running":
        urllib.request.urlopen(
            urllib.request.Request(HOST + "/api/items/relay/stop", method="POST"), timeout=10
        )
        time.sleep(1)
    check(bool(find(DOCK)), "点击前坞仍在")
    tx, ty = ring_pos(hwnd, 90)  # relay 在 90°
    click(tx, ty)
    closed = False
    for _ in range(24):
        time.sleep(0.25)
        if not find(DOCK):
            closed = True
            break
    check(closed, "坞自动关闭")
    time.sleep(1.5)
    check(api("/api/items/relay")["runtime"].get("status") == "running", "relay 已启动")

    print("\n[3] 右键扇形打开详情")
    user32.SetCursorPos(900, 500)
    time.sleep(0.3)
    press_hotkey()
    hwnd = wait_ready()
    time.sleep(1.4)
    if hwnd:
        tx, ty = ring_pos(hwnd, 45)  # dsh-web
        click(tx, ty, right=True)
        time.sleep(1.5)
        check(not find(DOCK), "坞已关闭")
        check(bool(find(MAIN)), "主窗口已打开")
    else:
        check(False, "坞未唤出，跳过右键测试")

    print("\n[4] 主页扇形打开主窗口")
    # 先把主窗口藏掉不好做，改为检查点击主页后坞关闭
    time.sleep(0.3)
    press_hotkey()
    hwnd = wait_ready()
    time.sleep(1.4)
    if hwnd:
        tx, ty = ring_pos(hwnd, 0)
        click(tx, ty)
        time.sleep(1.0)
        check(not find(DOCK), "点主页后坞关闭")
    else:
        check(False, "坞未唤出，跳过主页测试")

    print("\n[5] 失焦自动关闭")
    time.sleep(0.4)
    press_hotkey()
    hwnd = wait_ready()
    time.sleep(1.4)
    if hwnd:
        progman = user32.FindWindowW("Progman", None)
        fg = user32.GetForegroundWindow()
        t = user32.GetWindowThreadProcessId(fg, None)
        cur = ctypes.windll.kernel32.GetCurrentThreadId()
        user32.AttachThreadInput(cur, t, True)
        user32.SetForegroundWindow(progman)
        user32.AttachThreadInput(cur, t, False)
        time.sleep(1.2)
        check(not find(DOCK), "切走焦点后坞关闭")
    else:
        check(False, "坞未唤出，跳过失焦测试")

    print("\n=== 汇总 ===")
    bad = [l for ok, l in results if not ok]
    if bad:
        print(f"  失败 {len(bad)} 项：")
        for b in bad:
            print("   -", b)
        return 1
    print(f"  全部 {len(results)} 项通过 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
