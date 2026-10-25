"""Zen-Dock 桌面窗口外壳。

用法（正常从 zen-dock-window.bat 启动，不用手敲）：
    .venv\\Scripts\\pythonw.exe shell\\desktop.py
    .venv\\Scripts\\pythonw.exe shell\\desktop.py --port 7718
    .venv\\Scripts\\pythonw.exe shell\\desktop.py --hidden      # 静默进托盘（开机自启用）

行为：
1. 探测 127.0.0.1:<port>。已经在跑就直接连过去，不碰它。
2. 没在跑就拉起 `node index.mjs --no-open`，等端口就绪。
3. 开主窗口（--hidden 时不显示，直接进托盘）。
4. 注册全局热键，按下时在鼠标附近弹出拓展坞。
5. 窗口关掉之后，只清理自己拉起来的那个 node 进程。

为什么显式指定 storage_path：pywebview 默认 private_mode=True，用临时目录做
WebView2 的 user data folder，在某些会话里初始化会直接抛 E_ABORT (0x80004004)。
固定到项目内目录就正常了。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

from hotkey import HotkeyListener

ROOT = Path(__file__).resolve().parent.parent
SHELL = ROOT / "shell"
CONFIG = ROOT / "hub.config.json"
ICON = SHELL / "icon.ico"
ICON_PNG = SHELL / "icon.png"
WEBVIEW_DATA = ROOT / ".webview"
SERVER_LOG = SHELL / "server.log"
DESKTOP_LOG = SHELL / "desktop.log"

IS_WIN = os.name == "nt"
NO_WINDOW = subprocess.CREATE_NO_WINDOW if IS_WIN else 0

DOCK_W, DOCK_H = 560, 430      # 面板形态
RING_W, RING_H = 400, 400      # 圆环形态，正方形
# 圆环几何，必须和 panel.js 里的 R_OUT / R_IN / RC / MAX_HALF 一致
RING_R_OUT, RING_R_IN, RING_RC = 184, 66, 10
RING_MAX_HALF = 34
MAIN_TITLE = "Zen-Dock"
DOCK_TITLE = "Zen-Dock 快速启动"
SW_RESTORE = 9

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
gdi32 = ctypes.windll.gdi32


def setup_logging() -> None:
    """pythonw 下没有控制台。

    坑：pythonw 的 sys.stdout 不一定是 None，也可能是个"写入不报错但也不落盘"的
    黑洞对象，所以试写判断不可靠。直接看可执行文件名最稳——pythonw 就强制落文件。
    """
    headless = Path(sys.executable).name.lower().startswith("pythonw")
    if not headless and sys.stdout is not None:
        try:
            sys.stdout.write("")
            sys.stdout.flush()
            return
        except Exception:
            pass
    f = open(DESKTOP_LOG, "a", encoding="utf-8", buffering=1)
    sys.stdout = f
    sys.stderr = f


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def alert(title: str, text: str) -> None:
    """没有控制台时的错误提示，用系统原生消息框，不依赖 tkinter。"""
    log(f"ALERT {title}: {text}")
    if not IS_WIN:
        return
    try:
        ctypes.windll.user32.MessageBoxW(0, text, title, 0x10)
    except Exception:
        pass


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.3) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def wait_port(port: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_open(port):
            return True
        time.sleep(0.15)
    return False


def start_server(port: int) -> subprocess.Popen | None:
    node = shutil.which("node")
    if not node:
        alert("Zen-Dock", "找不到 node。先装 Node.js 20+ 并确保它在 PATH 里。")
        return None

    log(f"启动 node: {node} index.mjs --no-open --port {port}")
    SERVER_LOG.parent.mkdir(parents=True, exist_ok=True)
    out = open(SERVER_LOG, "ab", buffering=0)
    proc = subprocess.Popen(
        [node, "index.mjs", "--no-open", "--port", str(port)],
        cwd=str(ROOT),
        stdout=out,
        stderr=out,
        stdin=subprocess.DEVNULL,
        creationflags=NO_WINDOW,
    )
    if not wait_port(port, 25):
        alert(
            "Zen-Dock",
            f"服务没能在 25 秒内起来。\n\n端口 {port} 可能被别的程序占了，"
            f"或者 node 启动失败。\n日志：{SERVER_LOG}",
        )
        kill_tree(proc)
        return None
    log(f"服务就绪 http://127.0.0.1:{port}/")
    return proc


def kill_tree(proc: subprocess.Popen) -> None:
    if proc is None or proc.poll() is not None:
        return
    log(f"清理 node pid={proc.pid}")
    try:
        if IS_WIN:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                creationflags=NO_WINDOW,
            )
        else:
            proc.terminate()
            proc.wait(timeout=5)
    except Exception as e:
        log(f"清理失败：{e}")


# ---------- 设置 ----------


def read_settings() -> dict:
    """每次都读文件。设置页改完要立刻生效，所以不做缓存。"""
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
        return cfg.get("settings") or {}
    except Exception as e:
        log(f"读配置失败，按默认处理：{e}")
        return {}


def dock_slot_count() -> int:
    """圆环上一共几块：主页 + 坞内快捷项（上限 7）。

    跟 panel.js 的 computeSlots 保持一致的算法，否则区域和实际画的扇区对不上。
    """
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return 8
    picked = (cfg.get("settings") or {}).get("dockItems")
    if picked is None:
        items = cfg.get("items") or []
        picked = [i.get("id") for i in items if i.get("enabled", True)][:7]
    return 1 + min(len([x for x in picked if x]), 7)


def save_setting(key: str, value) -> None:
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"写设置失败，读不到配置：{e}")
        return
    cfg.setdefault("settings", {})[key] = value
    try:
        tmp = CONFIG.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(CONFIG)
    except Exception as e:
        log(f"写设置失败：{e}")


# ---------- 窗口查找 ----------

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def find_windows(title: str) -> list[int]:
    """按标题精确匹配顶层窗口。跨线程安全，不碰 WebView2 的 COM 对象。"""
    hits: list[int] = []

    def cb(hwnd, _lp):
        n = user32.GetWindowTextLengthW(hwnd)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value == title:
                hits.append(hwnd)
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return hits


def force_foreground(hwnd: int) -> bool:
    """把窗口强行拉到前台。

    直接 SetForegroundWindow 会被系统"前台锁定"挡住（只有当前前台进程才有权
    改前台）。标准绕法是先 AttachThreadInput 把自己挂到前台线程的输入队列上，
    改完再摘掉。
    """
    try:
        fg = user32.GetForegroundWindow()
        if fg == hwnd:
            return True
        fg_thread = user32.GetWindowThreadProcessId(fg, None)
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
    except Exception as e:
        log(f"抢前台失败：{e}")
        return False


# ---------- 鼠标附近定位 ----------

MONITOR_DEFAULTTONEAREST = 2


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def cursor_center(w: int, h: int) -> tuple[int, int]:
    """窗口左上角，让鼠标落在窗口正中心。

    故意不做贴边 clamp：一旦把窗口往里推，圆心就跟鼠标错开了，
    圆环就不是"围绕鼠标"了。贴边时宁可让窗口超出屏幕。
    """
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x - w // 2, pt.y - h // 2


RGN_DIFF = 4
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010


RGN_OR = 2
WINDING = 2


def _quad_points(p0, ctrl, p1, n):
    """二次贝塞尔离散成点，用来画圆角。"""
    out = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        out.append(
            (
                u * u * p0[0] + 2 * u * t * ctrl[0] + t * t * p1[0],
                u * u * p0[1] + 2 * u * t * ctrl[1] + t * t * p1[1],
            )
        )
    return out


def _sector_polygon(cx, cy, R, r, rc, a1, a2, steps=18):
    """圆角扇形的多边形顶点。

    跟 panel.js 里 sectorPath 用同一套算法（外弧 → 外角圆角 → 径向边 →
    内角圆角 → 内弧 → 内角圆角 → 径向边 → 外角圆角），只是这里离散成点，
    好喂给 CreatePolygonRgn。
    """
    import math

    dout = math.degrees(rc / R)
    din = math.degrees(rc / r)

    def pt(rad, deg):
        a = math.radians(deg)
        return (cx + rad * math.sin(a), cy - rad * math.cos(a))

    pts = []
    for i in range(steps + 1):
        deg = (a1 + dout) + ((a2 - dout) - (a1 + dout)) * i / steps
        pts.append(pt(R, deg))
    pts += _quad_points(pt(R, a2 - dout), pt(R, a2), pt(R - rc, a2), 4)
    pts.append(pt(r + rc, a2))
    pts += _quad_points(pt(r + rc, a2), pt(r, a2), pt(r, a2 - din), 4)
    for i in range(steps + 1):
        deg = (a2 - din) - ((a2 - din) - (a1 + din)) * i / steps
        pts.append(pt(r, deg))
    pts += _quad_points(pt(r, a1 + din), pt(r, a1), pt(r + rc, a1), 4)
    pts.append(pt(R - rc, a1))
    pts += _quad_points(pt(R - rc, a1), pt(R, a1), pt(R, a1 + dout), 4)
    return pts


def _polygon_rgn(pts):
    n = len(pts)
    arr = (wintypes.POINT * n)()
    for i, (x, y) in enumerate(pts):
        arr[i] = wintypes.POINT(int(round(x)), int(round(y)))
    return gdi32.CreatePolygonRgn(arr, n, WINDING)


def set_sectors_region(hwnd: int, w: int, h: int, count: int,
                       r_out: float, r_in: float, rc: float,
                       max_half: float) -> bool:
    """把命中区域裁成 N 块扇形的并集。

    为什么不是环形：环形会把扇区之间的间隙也包进窗口区域，那些间隙没有
    任何东西覆盖，露出的就是 WinForms 窗体的默认背景色（#F0F0F0）——也就是
    肉眼看到的"白边"。改成扇形并集后，间隙和环外一起被剔除，真正透明。

    半径和角度各外扩一点（1.5px / 0.4°），给硬裁剪边缘留抗锯齿的余量。
    """
    cx, cy = w // 2, h // 2
    step = 360.0 / max(1, count)
    half = min(step / 2 - 2.5, max_half) + 0.4
    R = r_out + 1.5
    r = max(2.0, r_in - 1.5)

    total = None
    try:
        for i in range(count):
            mid = i * step
            pts = _sector_polygon(cx, cy, R, r, rc, mid - half, mid + half)
            rgn = _polygon_rgn(pts)
            if not rgn:
                continue
            if total is None:
                total = rgn
            else:
                gdi32.CombineRgn(total, total, rgn, RGN_OR)
                gdi32.DeleteObject(rgn)
        if total is None:
            log("扇形区域创建失败")
            return False
        user32.SetWindowRgn(hwnd, total, True)
        return True
    except Exception as e:
        log(f"设置扇形区域出错：{e}")
        return False


def cursor_anchor(w: int, h: int) -> tuple[int, int]:
    """把窗口放在鼠标右下角；贴边时翻到内侧。多屏按鼠标所在屏的工作区算。"""
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))

    hmon = user32.MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST)
    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(MONITORINFO)
    if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
        sw = user32.GetSystemMetrics(0)
        sh = user32.GetSystemMetrics(1)
        mi.rcWork = wintypes.RECT(0, 0, sw, sh)

    work = mi.rcWork
    x = pt.x + 14
    y = pt.y + 14
    if x + w > work.right:
        x = max(work.left + 8, work.right - w - 10)
    if y + h > work.bottom:
        y = max(work.top + 8, work.bottom - h - 10)
    return x, y


# ---------- 托盘 ----------


class Tray:
    """托盘常驻。只在需要时创建（最小化 / 静默启动）。"""

    def __init__(self) -> None:
        self.icon = None
        self._app = None

    def ensure(self, app) -> bool:
        if self.icon is not None:
            return True
        try:
            import pystray
            from PIL import Image
        except Exception as e:
            log(f"托盘依赖缺失：{e}")
            return False

        self._app = app
        source = ICON_PNG if ICON_PNG.exists() else ICON
        try:
            image = Image.open(source).convert("RGBA").resize((64, 64), Image.LANCZOS)
        except Exception as e:
            log(f"托盘图标加载失败：{e}")
            return False

        menu = pystray.Menu(
            pystray.MenuItem("显示主窗口", self._show_main, default=True),
            pystray.MenuItem("快速启动", self._show_dock),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出 Zen-Dock", self._exit),
        )
        icon = pystray.Icon("zen-dock", image, "Zen-Dock", menu)
        self.icon = icon
        threading.Thread(target=icon.run, daemon=True).start()
        log("托盘已启动")
        return True

    def notify(self, message: str, title: str = "Zen-Dock") -> None:
        if self.icon is None:
            return
        try:
            self.icon.notify(message, title)
        except Exception:
            pass

    def _show_main(self, icon=None, item=None) -> None:
        if self._app:
            self._app.show_main()

    def _show_dock(self, icon=None, item=None) -> None:
        if self._app:
            self._app.open_dock()

    def _exit(self, icon=None, item=None) -> None:
        log("托盘请求退出")
        if self.icon is not None:
            try:
                self.icon.stop()
            except Exception:
                pass
        if self._app:
            self._app.request_quit()

    def stop(self) -> None:
        if self.icon is not None:
            try:
                self.icon.stop()
            except Exception:
                pass
            self.icon = None


# ---------- js_api：前端能调到的 Python 方法 ----------


class Api:
    """暴露给前端 JS 的方法。

    注意：持有 App 的属性必须以下划线开头。pywebview 会枚举 js_api 对象的公开
    属性并递归处理，写成 self.app 会导致它一路遍历到窗口、WinForms 控件，
    最后 maximum recursion depth exceeded。
    """

    def __init__(self, app: "App") -> None:
        self._app = app

    # 注意：pywebview 调 js_api 时总会额外塞一个参数进来（实测如此），
    # 所以无参方法必须收 *_，否则 TypeError: takes 1 positional argument but 2 were given。

    def close(self, *_):
        self._app.close_dock()
        return True

    def open_home(self, *_):
        """圆环 12 点那块「主页」：关掉坞，把主窗口叫出来。"""
        log("点主页：关坞 + 叫主窗口")
        self._app.close_dock()
        self._app.show_main()
        return True

    def show_logs(self, item_id: str, *_):
        self._app.close_dock()
        self._app.show_main()
        self._app.call_main_js("openDrawer", item_id)
        return True

    def show_edit(self, item_id: str, *_):
        self._app.close_dock()
        self._app.show_main()
        self._app.call_main_js("openEditor", item_id)
        return True

    def set_hotkey(self, spec: str, *_):
        return self._app.set_hotkey(spec)

    def hotkey_status(self, *_):
        return self._app.hotkey_status()

    def open_dock(self, *_):
        self._app.open_dock()
        return True


class App:
    def __init__(self, port: int, host: str) -> None:
        self.port = port
        self.host = host
        self.main = None
        self.dock = None
        self.tray = Tray()
        self.hotkey = HotkeyListener()
        self.hotkey_want = read_settings().get("hotkey") or "alt+x"
        self.quitting = False
        self.api = Api(self)

    # ---- 窗口 ----
    def show_main(self) -> None:
        if self.main is None:
            log("show_main: 主窗口对象是 None，跳过")
            return
        try:
            self.main.show()
            self.main.restore()
        except Exception as e:
            log(f"pywebview 显示主窗口失败：{e}")

        # 兜底：--hidden 启动的窗口、或者被外部 SW_HIDE 过的窗口，
        # pywebview 的 show()/restore() 不一定真能把它弄出来（WinForms 那边
        # 认为 Visible 还是 true，就不动作）。直接走 Win32 再来一遍。
        hits = find_windows(MAIN_TITLE)
        if hits:
            hwnd = hits[0]
            user32.ShowWindow(hwnd, SW_RESTORE)
            user32.SetForegroundWindow(hwnd)
            log("show_main: 已用 Win32 强制显示并置前")
        else:
            log("show_main: 找不到主窗口句柄")

    def call_main_js(self, fn: str, arg) -> None:
        if self.main is None:
            return
        try:
            self.main.evaluate_js(
                "window.__zenDock && window.__zenDock.%s(%s)" % (fn, json.dumps(arg))
            )
        except Exception as e:
            log(f"调用主窗口 JS 失败：{e}")

    # ---- 拓展坞 ----
    def toggle_dock(self) -> None:
        log("热键触发 toggle_dock")
        try:
            if self.dock is not None:
                self.close_dock()
            else:
                self.open_dock()
        except Exception as e:
            log(f"切换拓展坞失败：{type(e).__name__}: {e}")

    def open_dock(self) -> None:
        if self.dock is not None:
            try:
                self.dock.show()
                self.dock.restore()
            except Exception:
                pass
            return
        import webview

        # 形态每次现读配置，设置页改完下次唤出就生效
        ring = (read_settings().get("dockMode") or "ring") == "ring"
        if ring:
            w, h = RING_W, RING_H
            x, y = cursor_center(w, h)
            extra = dict(
                transparent=True,
                shadow=False,
                background_color="#000000",
            )
        else:
            w, h = DOCK_W, DOCK_H
            x, y = cursor_anchor(w, h)
            extra = dict(background_color="#0b0e14")

        try:
            win = webview.create_window(
                DOCK_TITLE,
                url=f"http://{self.host}:{self.port}/dock",
                width=w,
                height=h,
                x=x,
                y=y,
                frameless=True,
                easy_drag=False,
                on_top=True,
                resizable=False,
                js_api=self.api,
                **extra,
            )
        except Exception as e:
            log(f"打开拓展坞失败：{e}")
            self.tray.notify(f"拓展坞打不开：{e}")
            return

        self.dock = win
        win.events.closed += self._on_dock_closed
        log(f"拓展坞已打开 ({x},{y}) 形态={'圆环' if ring else '面板'}")
        if ring:
            threading.Thread(target=self._apply_ring_region, args=(win,), daemon=True).start()
        threading.Thread(target=self._watch_dock_focus, args=(win,), daemon=True).start()

    def _apply_ring_region(self, win) -> None:
        """等窗口真正创建出来，再把它裁成环形。

        半径按窗口实际尺寸换算：无边框窗口的最终大小不一定等于请求值
        （实测请求 400x400 拿到过 384x361），SVG 那边用 preserveAspectRatio
        居中缩放，所以按 min(w,h)/400 折算才对得上。
        """
        hwnd = 0
        for _ in range(40):
            time.sleep(0.05)
            hits = find_windows(DOCK_TITLE)
            if hits:
                hwnd = hits[0]
                break
        if not hwnd:
            log("没找到坞窗口，跳过环形区域（点击环外不会穿透）")
            return

        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        w, h = rect.right - rect.left, rect.bottom - rect.top

        # 先试着把尺寸掰回正方形，掰不动就用实际尺寸折算
        if (w, h) != (RING_W, RING_H):
            user32.SetWindowPos(
                hwnd, 0, rect.left, rect.top, RING_W, RING_H,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
            time.sleep(0.06)
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w, h = rect.right - rect.left, rect.bottom - rect.top

        scale = min(w, h) / float(RING_W)
        count = dock_slot_count()
        # 几何参数必须跟 panel.js 里的一致，否则区域和画出来的扇区错位
        ok = set_sectors_region(
            hwnd, w, h, count,
            RING_R_OUT * scale, RING_R_IN * scale, RING_RC * scale, RING_MAX_HALF,
        )
        log(f"扇形区域 {'已设置' if ok else '设置失败'} 窗口 {w}x{h} {count} 块")

    def _on_dock_closed(self) -> None:
        self.dock = None
        log("拓展坞已关闭")

    def close_dock(self) -> None:
        win = self.dock
        self.dock = None
        if win is not None:
            try:
                win.destroy()
            except Exception:
                pass

    def _watch_dock_focus(self, win) -> None:
        """失焦自动关闭。

        不能用 evaluate_js —— WebView2 的 COM 对象只能在 UI 线程访问，从子线程调
        会刷一屏 "CoreWebView2 can only be accessed from the UI thread"。
        改成轮询 Win32 的前台窗口句柄，任何线程都安全。

        关键：必须等窗口**真的拿到焦点**之后再开始监控。否则窗口刚创建、还没
        Activate 时前台还是上一个程序，第一轮检测就会判成失焦，坞一闪就没了。
        """
        hwnd = 0
        for _ in range(40):
            time.sleep(0.08)
            hits = find_windows(DOCK_TITLE)
            if hits:
                hwnd = hits[0]
                break
        if not hwnd:
            log("拓展坞窗口没出现，跳过失焦监控")
            return

        # 抢焦点要重试到"稳定保持"为止：WebView2 初始化过程中会短暂把焦点弄丢，
        # 只成功一次不够，得确认它连续 0.45 秒都在前台。
        stable_since = 0.0
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if user32.GetForegroundWindow() == hwnd:
                if not stable_since:
                    stable_since = time.time()
                elif time.time() - stable_since >= 0.45:
                    break
            else:
                stable_since = 0.0
                force_foreground(hwnd)
            time.sleep(0.1)

        if not stable_since or time.time() - stable_since < 0.45:
            log("拓展坞焦点一直不稳，跳过失焦自动关闭（按 Esc 或再按热键关闭）")
            return

        while self.dock is win and not self.quitting:
            time.sleep(0.22)
            fg = user32.GetForegroundWindow()
            # fg == 0 表示"当前没有前台窗口"（切到任务栏、切换虚拟桌面、
            # 或者从没有前台权限的进程里启动时都会这样）。这不算失焦，
            # 否则坞刚弹出来就会被自己关掉。
            if fg and fg != hwnd:
                # 再确认一次：焦点在窗口创建、动画、托盘气泡这些时机上会瞬时抖动，
                # 一次就关会让坞"闪一下就没了"。0.35 秒后还是别人，才算真失焦。
                time.sleep(0.35)
                fg2 = user32.GetForegroundWindow()
                if fg2 and fg2 != hwnd:
                    log(f"拓展坞失焦（前台 hwnd={fg2}，坞 hwnd={hwnd}）")
                    self.close_dock()
                    return

    # ---- 热键 ----
    def start_hotkey(self) -> None:
        try:
            spec = self.hotkey.start(self.hotkey_want, self.toggle_dock)
            self.hotkey_want = spec
            log(f"热键已注册：{spec}")
        except Exception as e:
            log(f"热键注册失败（{self.hotkey_want}）：{e}")

    def set_hotkey(self, spec: str) -> dict:
        spec = (spec or "").strip().lower()
        old = self.hotkey.spec or self.hotkey_want
        try:
            got = self.hotkey.start(spec, self.toggle_dock)
        except Exception as e:
            log(f"换热键失败（{spec}）：{e}")
            # 失败要把旧的热键恢复回来，否则用户会失去唤出能力
            try:
                self.hotkey.start(old, self.toggle_dock)
            except Exception:
                pass
            return {"ok": False, "error": str(e), "spec": old}

        self.hotkey_want = got
        save_setting("hotkey", got)
        log(f"热键已切换到：{got}")
        return {"ok": True, "spec": got}

    def hotkey_status(self) -> dict:
        return {
            "ok": self.hotkey.spec is not None,
            "spec": self.hotkey.spec or "",
            "want": self.hotkey_want,
        }

    # ---- 退出 ----
    def request_quit(self) -> None:
        self.quitting = True
        self.close_dock()
        try:
            if self.main is not None:
                self.main.destroy()
        except Exception as e:
            log(f"销毁主窗口失败：{e}")


def main() -> int:
    setup_logging()

    parser = argparse.ArgumentParser(description="Zen-Dock 桌面窗口")
    parser.add_argument("--port", type=int, default=7717)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--hidden", action="store_true", help="静默启动：不显示窗口，直接进托盘")
    parser.add_argument("--auto-close", type=float, default=0, help=argparse.SUPPRESS)
    args = parser.parse_args()

    log("=" * 50)
    log(f"Zen-Dock desktop shell{' (hidden)' if args.hidden else ''}")

    import webview  # 放这里，出错时日志已经就绪

    server_proc = None
    if port_open(args.port):
        log(f"端口 {args.port} 已有服务在跑，直接连过去")
    else:
        server_proc = start_server(args.port)
        if server_proc is None:
            return 1

    WEBVIEW_DATA.mkdir(parents=True, exist_ok=True)

    app = App(args.port, args.host)

    app.main = webview.create_window(
        "Zen-Dock",
        url=f"http://{args.host}:{args.port}/",
        width=1280,
        height=860,
        min_size=(900, 600),
        background_color="#0b0e14",
        hidden=args.hidden,
        js_api=app.api,
    )

    def on_closing() -> bool:
        """返回 False 可以拦下这次关闭。"""
        if app.quitting:
            return True
        action = read_settings().get("closeAction", "quit")
        if action == "tray" or args.hidden:
            if app.tray.ensure(app):
                app.main.hide()
                log("已最小化到托盘")
                return False
            log("托盘不可用，改为直接退出")
        return True

    app.main.events.closing += on_closing

    if args.hidden:
        # 静默启动：窗口不显示，但托盘必须在，否则没法唤出来
        app.tray.ensure(app)

    app.start_hotkey()

    try:
        if args.auto_close:
            # 仅用于自动化验证，正式使用不会走到这里
            def _closer() -> None:
                time.sleep(args.auto_close)
                app.request_quit()

            threading.Thread(target=_closer, daemon=True).start()

        webview.start(
            gui="edgechromium",
            private_mode=False,
            storage_path=str(WEBVIEW_DATA),
            icon=str(ICON) if ICON.exists() else None,
        )
    except Exception as e:
        alert("Zen-Dock", f"窗口启动失败：\n{type(e).__name__}: {e}")
        app.hotkey.stop()
        app.tray.stop()
        kill_tree(server_proc)
        return 1

    app.hotkey.stop()
    app.tray.stop()
    log("窗口已关闭")
    kill_tree(server_proc)
    log("退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
