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
INSTANCE_FILE = SHELL / "instance.json"   # 单实例的唤醒口地址，随进程生灭

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
SW_MINIMIZE = 6
SW_HIDE = 0

# 单实例互斥体。Local\ 只作用于当前登录会话，正是我们要的范围：
# 同一台机器上不同用户各开一个互不干扰。
MUTEX_NAME = "Local\\Zen-Dock-Shell"
ERROR_ALREADY_EXISTS = 183
STILL_ACTIVE = 259

# 无边框窗口的自绘拖动/缩放：把命中测试交给系统的非客户区处理，
# 效果和拖标题栏、拖边框完全一样（有 Aero Snap，不抖）。
WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2
HT_LEFT, HT_RIGHT, HT_TOP = 10, 11, 12
HT_TOPLEFT, HT_TOPRIGHT, HT_BOTTOM = 13, 14, 15
HT_BOTTOMLEFT, HT_BOTTOMRIGHT = 16, 17
HT_DIRS = {
    "w": HT_LEFT, "e": HT_RIGHT, "n": HT_TOP, "s": HT_BOTTOM,
    "nw": HT_TOPLEFT, "ne": HT_TOPRIGHT, "sw": HT_BOTTOMLEFT, "se": HT_BOTTOMRIGHT,
}

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


# ---------- 单实例 ----------
#
# 判据用命名互斥体（内核对象，进程一死就自动释放，不会留脏锁），
# 唤醒用本地 TCP 小口子（第一实例把端口写进 instance.json）。
# 为什么不用 FindWindow 当判据：坞窗口、主窗口都叫 Zen-Dock*，而且窗口可能
# 被隐藏，靠标题猜不可靠。互斥体是唯一的权威判定。

_instance_mutex = None  # 必须常驻引用，句柄一被回收互斥体就没了


def acquire_instance_lock() -> bool:
    """第一个实例返回 True；已有实例在跑返回 False。"""
    global _instance_mutex
    try:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateMutexW.restype = wintypes.HANDLE
        _instance_mutex = k32.CreateMutexW(None, False, MUTEX_NAME)
        if not _instance_mutex:
            log("CreateMutexW 失败，按单实例放行")
            return True
        return ctypes.get_last_error() != ERROR_ALREADY_EXISTS
    except Exception as e:
        log(f"单实例检测异常（放行）：{e}")
        return True


def pid_alive(pid: int) -> bool:
    if not pid:
        return False
    try:
        h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = wintypes.DWORD()
        ok = kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        kernel32.CloseHandle(h)
        return bool(ok) and code.value == STILL_ACTIVE
    except Exception:
        return False


def read_instance() -> dict:
    try:
        return json.loads(INSTANCE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_instance(wake_port: int) -> None:
    try:
        INSTANCE_FILE.write_text(
            json.dumps(
                {"pid": os.getpid(), "wake": wake_port, "startedAt": int(time.time() * 1000)},
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
    except Exception as e:
        log(f"写 instance.json 失败（唤醒通道仍可用）：{e}")


def clear_instance() -> None:
    """只删自己写的，别把后起的实例的登记删掉。"""
    try:
        if read_instance().get("pid") == os.getpid():
            INSTANCE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def start_wake_server(on_show) -> int:
    """起一个只认 show 的本地小口子，返回实际端口（失败 0）。

    故意用系统分配的随机端口 + instance.json 记录，而不是固定 port+1：
    固定端口一旦被别的程序占住，唤醒就永久失效，而随机端口不会冲突。
    """
    srv = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # 不设 SO_REUSEADDR：Windows 上它允许抢占别人已经监听的端口，
        # 会出现"两个实例都绑成功、请求随机落到一个"的鬼事。
        s.bind(("127.0.0.1", 0))
        s.listen(4)
        srv = s
    except OSError as e:
        log(f"唤醒口绑定失败：{e}")
        return 0

    def loop() -> None:
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            with conn:
                try:
                    conn.settimeout(1.5)
                    data = conn.recv(64).strip().lower()
                    if data.startswith(b"show"):
                        log("收到唤醒请求，显示主窗口")
                        on_show()
                        conn.sendall(b"ok\n")
                    elif data.startswith(b"ping"):
                        conn.sendall(b"ok\n")
                    else:
                        conn.sendall(b"?\n")
                except Exception:
                    pass

    threading.Thread(target=loop, daemon=True).start()
    return srv.getsockname()[1]


def wake_existing(timeout: float = 4.0) -> bool:
    """叫醒已经在跑的实例：先走唤醒口，再降级到 Win32 直接显示窗口。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        info = read_instance()
        port, pid = int(info.get("wake") or 0), int(info.get("pid") or 0)
        if port and pid_alive(pid):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1.5) as s:
                    s.sendall(b"show\n")
                    s.settimeout(1.0)
                    if s.recv(8).strip() == b"ok":
                        log(f"已通过唤醒口叫起实例 pid={pid}")
                        return True
            except Exception as e:
                log(f"唤醒口没通（{type(e).__name__}），改试 Win32")
                break
        # 第一个实例可能还在启动、没写登记文件，给它一点时间
        time.sleep(0.25)

    hits = find_windows(MAIN_TITLE)
    if hits:
        user32.ShowWindow(hits[0], SW_RESTORE)
        force_foreground(hits[0])
        log("已用 Win32 直接唤起已有窗口")
        return True
    log("找不到已有实例的窗口")
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


def _sector_polygon(cx, cy, R, r, rc, a1, a2, steps=60):
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
    pts += _quad_points(pt(R, a2 - dout), pt(R, a2), pt(R - rc, a2), 7)
    pts.append(pt(r + rc, a2))
    pts += _quad_points(pt(r + rc, a2), pt(r, a2), pt(r, a2 - din), 7)
    for i in range(steps + 1):
        deg = (a2 - din) - ((a2 - din) - (a1 + din)) * i / steps
        pts.append(pt(r, deg))
    pts += _quad_points(pt(r, a1 + din), pt(r, a1), pt(r + rc, a1), 7)
    pts.append(pt(R - rc, a1))
    pts += _quad_points(pt(R - rc, a1), pt(R, a1), pt(R, a1 + dout), 7)
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

    区域要**外扩** 1.5px，把 SVG 的抗锯齿像素完整包进来。

    这里的原理是：窗口背景本来就是透明的（WebView2 的 DComp 视觉树直出，
    Form 的 BackColor 根本不参与合成），所以区域内、扇形之外多出来的那
    1.5px 会正常透出桌面，不会露任何底色。

    反过来，如果内缩，就会把抗锯齿带一刀切掉 —— 边缘变成硬阶梯，
    每一级都露着背景色，在浅色桌面上看起来就是一圈毛边。

    外扩的前提是区域为"扇形并集"而不是"完整环形"：环形会把扇区之间的
    间隙也包进去，那些间隙没有内容覆盖，才会露出窗体底色。
    """
    cx, cy = w // 2, h // 2
    step = 360.0 / max(1, count)
    half = min(step / 2 - 2.5, max_half)
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

    # ---- 自绘标题栏（主窗口是无边框的，这些是它唯一的窗口按钮通路）----

    def win_drag(self, *_):
        self._app.begin_drag()
        return True

    def win_resize(self, direction: str, *_):
        self._app.begin_resize(direction)
        return True

    def win_minimize(self, *_):
        self._app.minimize_main()
        return True

    def win_maximize(self, *_):
        return self._app.toggle_maximize_main()

    def win_close(self, *_):
        self._app.close_main()
        return True

    def win_state(self, *_):
        return {"maximized": bool(self._app.maxed)}


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
        self._main_hwnd = 0        # 主窗口句柄缓存
        self.maxed = False         # 自绘最大化状态（无边框窗口不能靠 IsZoomed 判断）
        self._restore_rect = None  # 最大化前的窗口矩形

    # ---- 主窗口的窗口操作（无边框，全部走 Win32）----
    def main_hwnd(self) -> int:
        """主窗口句柄。句柄会随窗口重建失效，所以每次都验一下。"""
        if self._main_hwnd and user32.IsWindow(self._main_hwnd):
            return self._main_hwnd
        hits = find_windows(MAIN_TITLE)
        self._main_hwnd = hits[0] if hits else 0
        return self._main_hwnd

    def begin_drag(self) -> None:
        """把这次按下交给系统的"拖动标题栏"处理。

        必须用 PostMessage 而不是 SendMessage：js_api 是在 UI 线程上执行的，
        SendMessage 会同步等移动循环结束，直接把界面卡死。
        """
        hwnd = self.main_hwnd()
        if not hwnd:
            log("begin_drag: 找不到主窗口句柄")
            return
        try:
            if self.maxed:
                self._unmaximize(hwnd, follow_cursor=True)
            user32.ReleaseCapture()
            user32.PostMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)
        except Exception as e:
            log(f"拖动失败：{e}")

    def begin_resize(self, direction: str) -> None:
        hwnd = self.main_hwnd()
        if not hwnd:
            return
        if self.maxed:  # 最大化状态下不许拉边
            return
        code = HT_DIRS.get((direction or "").strip().lower())
        if code is None:
            log(f"未知的缩放方向：{direction}")
            return
        try:
            user32.ReleaseCapture()
            user32.PostMessageW(hwnd, WM_NCLBUTTONDOWN, code, 0)
        except Exception as e:
            log(f"缩放失败：{e}")

    def minimize_main(self) -> None:
        hwnd = self.main_hwnd()
        if not hwnd:
            return
        # 无边框窗口的最小化按钮不一定在任务栏，托盘得先就位，否则用户找不回来
        self.tray.ensure(self)
        try:
            user32.ShowWindow(hwnd, SW_MINIMIZE)
            log("主窗口已最小化")
        except Exception as e:
            log(f"最小化失败：{e}")

    def _work_area(self, hwnd: int):
        hmon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            return None
        return mi.rcWork

    def _unmaximize(self, hwnd: int, follow_cursor: bool = False) -> None:
        self.maxed = False
        rect = self._restore_rect
        if not rect:
            return
        x, y, w, h = rect
        if follow_cursor:
            # 拖动还原时让窗口跟着鼠标走，跟系统标题栏的行为一致
            pt = wintypes.POINT()
            user32.GetCursorPos(ctypes.byref(pt))
            x = pt.x - w // 2
            y = pt.y - 14
        user32.SetWindowPos(hwnd, 0, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE)

    def toggle_maximize_main(self) -> dict:
        hwnd = self.main_hwnd()
        if not hwnd:
            return {"maximized": self.maxed}
        try:
            if self.maxed:
                self._unmaximize(hwnd)
            else:
                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                self._restore_rect = (
                    rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top
                )
                work = self._work_area(hwnd)
                if work is None:
                    return {"maximized": False}
                # 不用 SW_MAXIMIZE：无边框窗口最大化会盖住任务栏，
                # 手工铺满工作区才跟普通窗口的观感一致。
                user32.SetWindowPos(
                    hwnd, 0, work.left, work.top,
                    work.right - work.left, work.bottom - work.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                )
                self.maxed = True
            log(f"主窗口{'最大化' if self.maxed else '还原'}")
        except Exception as e:
            log(f"最大化切换失败：{e}")
        return {"maximized": self.maxed}

    def close_main(self) -> None:
        """自绘的关闭按钮。语义必须和系统关闭按钮（on_closing）一致。"""
        if self.quitting:
            return
        action = read_settings().get("closeAction", "quit")
        if action == "tray":
            if self.tray.ensure(self):
                try:
                    self.main.hide()
                except Exception as e:
                    log(f"pywebview 隐藏失败，改走 Win32：{e}")
                # 兜底：WinForms 的 hide() 在某些时序下不生效，窗口会赖在屏幕上
                hwnd = self.main_hwnd()
                if hwnd and user32.IsWindowVisible(hwnd):
                    user32.ShowWindow(hwnd, SW_HIDE)
                log("已最小化到托盘")
                return
            log("托盘不可用，改为直接退出")
        self.request_quit()

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

    def _paint_form_backdrop(self, win, rgb=(22, 27, 38)) -> None:
        """把 WinForms 窗体底色设成页面底色。

        这不是"换个颜色掩盖"，是原理上必须的一步。

        WebView2 的 DefaultBackgroundColor 只接受 alpha=0 或 255（传半透明会
        直接 E_INVALIDARG）。alpha=0 时它**把宿主窗口自己的像素当作背景来渲染**
        —— 也就是说 SVG 的抗锯齿像素混的是 Form.BackColor，不是桌面。

        Form 的默认底色是 SystemColors.Control = #F0F0F0（浅灰），而
        transparent=True 那个分支只设了 WebView2 的背景，从来没设过 Form 的
        BackColor。所以：区域内凡是页面没覆盖到的地方（抗锯齿带、区域外扩的
        那 1.5px）露出来的都是浅灰，跨任何桌面背景都不变 —— 这就是那条
        "奇怪的底边"，也是为什么换背景色没用。

        圆环坞传 #161b26（= 扇形 fill），主窗口传 #0b0e14（= --bg）。
        底色和页面底色差 0，边缘过渡带自然消失。
        """
        try:
            import clr  # pythonnet，pywebview 启动时已加载
            clr.AddReference("System.Drawing")
            from System.Drawing import Color

            win.native.BackColor = Color.FromArgb(*rgb)
            log(f"窗体底色已设为 #{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}")
        except Exception as e:
            log(f"设置窗体底色失败（不影响使用）：{type(e).__name__}: {e}")

    def _apply_ring_region(self, win) -> None:
        """等窗口真正创建出来，再把它裁成环形。

        半径按窗口实际尺寸换算：无边框窗口的最终大小不一定等于请求值
        （实测请求 400x400 拿到过 384x361），SVG 那边用 preserveAspectRatio
        居中缩放，所以按 min(w,h)/400 折算才对得上。
        """
        self._paint_form_backdrop(win)

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
                # 正常情况下页面自己监听 blur 就够了（有收缩动画），这里只是兜底：
                # 万一把 JS 那条路堵了（比如页面加载失败），别让坞赖着不走。
                # 所以等得久一点，给 JS 的 190ms 动画留足时间——它先关掉的话，
                # 这个循环会因为 self.dock 变成 None 自己退出。
                time.sleep(0.9)
                fg2 = user32.GetForegroundWindow()
                if fg2 and fg2 != hwnd and self.dock is win:
                    log(f"拓展坞失焦兜底关闭（前台 hwnd={fg2}，坞 hwnd={hwnd}）")
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
    parser.add_argument("--multi", action="store_true", help=argparse.SUPPRESS)  # 跳过单实例判定，仅测试用
    args = parser.parse_args()

    log("=" * 50)
    log(f"Zen-Dock desktop shell{' (hidden)' if args.hidden else ''}")

    # 单实例必须在 import webview 之前判：两个进程同时初始化 WebView2 的
    # user data folder 会互相踩，甚至直接 E_ABORT。
    if not args.multi and not acquire_instance_lock():
        log("已有实例在跑，按单实例策略只保留一个")
        if args.hidden:
            log("这次是静默启动，直接退出（不打扰已在跑的那个）")
        elif wake_existing():
            log("已唤起已有实例，本进程退出")
        else:
            log("唤不起来，但也不再开第二个，本进程退出")
        return 0

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
        # 主窗口也是无边框：标题栏和窗口按钮由页面自绘（panel.js 的 #titlebar），
        # 边框则内化成一圈 inset 描边，跟拓展坞的无边框风格统一。
        frameless=True,
        easy_drag=False,  # 拖动自己做，否则整页都能拖，点按钮会误拖窗口
        shadow=False,
        js_api=app.api,
    )

    # 主窗口有了对象才起唤醒口，避免第二个实例在窗口就绪前打进来打空
    wake_port = start_wake_server(app.show_main)
    write_instance(wake_port)
    log(f"单实例已就位，唤醒口 127.0.0.1:{wake_port}")

    def on_ready() -> None:
        """WebView2 的宿主窗口这时才真正存在，可以刷底色了。"""
        app._paint_form_backdrop(app.main, (11, 14, 20))  # #0b0e14 = --bg

    app.main.events.loaded += on_ready

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
        clear_instance()
        kill_tree(server_proc)
        return 1

    app.hotkey.stop()
    app.tray.stop()
    clear_instance()
    log("窗口已关闭")
    kill_tree(server_proc)
    log("退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
