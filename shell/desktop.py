"""Zen-Dock 桌面窗口外壳。

用法（正常从 zen-dock-window.bat 启动，不用手敲）：
    .venv\\Scripts\\pythonw.exe shell\\desktop.py
    .venv\\Scripts\\pythonw.exe shell\\desktop.py --port 7718
    .venv\\Scripts\\pythonw.exe shell\\desktop.py --hidden      # 静默进托盘（开机自启用）

行为：
1. 探测 127.0.0.1:<port>。已经在跑就直接连过去，不碰它。
2. 没在跑就拉起 `node index.mjs --no-open`，等端口就绪。
3. 开主窗口（--hidden 时进托盘，窗口和 WebView2 留到第一次真正需要再建）。
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
# 圆环形态的窗口、几何、配色全部在 ring.py 里 —— 它自己开分层窗口自绘，
# 不走 pywebview。这里不再保留 RING_* 常量，免得两份几何各改一半。
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

# 无边框窗口的缩放方向。值用的是系统的 HTxxx 命中码，现在只当方向白名单使
# （真正算新矩形的是 App.resize_to，因为系统拖边循环在 WebView2 上收不到
# mousemove，见 begin_drag 的注释）。
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


RGN_DIFF = 4
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010


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

    def win_drag_begin(self, *_):
        return self._app.begin_drag()

    def win_drag_to(self, dx: float, dy: float, *_):
        return self._app.drag_to(dx, dy)

    def win_drag_end(self, *_):
        return self._app.end_drag()

    def win_resize_begin(self, direction: str, *_):
        return self._app.begin_resize(direction)

    def win_resize_to(self, dx: float, dy: float, *_):
        return self._app.resize_to(dx, dy)

    def win_resize_end(self, *_):
        return self._app.end_resize()

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
        self.dock = None      # 面板形态的 pywebview 窗口
        self.ring = None      # 圆环形态的分层窗口（shell/ring.py）
        self.tray = Tray()
        self.hotkey = HotkeyListener()
        self.hotkey_want = read_settings().get("hotkey") or "alt+x"
        self.quitting = False
        self.api = Api(self)
        # 静默启动不建主窗口，主线程要靠这个事件被叫醒（见 wait_for_main_request）
        self._window_requested = threading.Event()
        self._window_show = True   # 被叫醒时主窗口要不要显示（面板坞只需要 GUI 循环）
        self._pending_dock = False # 叫醒原因：面板形态的坞要等 GUI 循环起来再开
        self._page_ready = False   # 页面 load 完之前，JS 调用先排队
        self._pending_js = []
        self._flash_on_load = False
        self._main_hwnd = 0        # 主窗口句柄缓存
        self.maxed = False         # 自绘最大化状态（无边框窗口不能靠 IsZoomed 判断）
        self._restore_rect = None  # 最大化前的窗口矩形
        self._drag_origin = None   # 拖动起点（窗口左上角）
        self._resize_state = None  # 缩放起点（初始矩形 + 方向）
        self.min_size = (900, 600) # 和 create_window 的 min_size 保持一致

    # ---- 主窗口的窗口操作（无边框，全部走 Win32）----
    def main_hwnd(self) -> int:
        """主窗口句柄。句柄会随窗口重建失效，所以每次都验一下。"""
        if self._main_hwnd and user32.IsWindow(self._main_hwnd):
            return self._main_hwnd
        hits = find_windows(MAIN_TITLE)
        self._main_hwnd = hits[0] if hits else 0
        return self._main_hwnd

    def begin_drag(self) -> bool:
        """拖动开始：记住窗口当前位置，后面按 JS 报上来的位移算新位置。

        为什么不用「WM_NCLBUTTONDOWN + HTCAPTION 交给系统移动循环」：
        那条路在 WebView2 上走不通。鼠标按下的瞬间 WebView2 会把鼠标捕获
        抢到自己那个子窗口（Chrome_WidgetWin_1）上，随后 DefWindowProc 的
        移动循环虽然能 SetCapture 回顶层窗口，但实际跑起来收不到 mousemove，
        窗口一动不动 —— 实测就是这样，不是理论问题。

        pywebview 自己的 easy_drag 也是这条路（JS 算位移 → SetWindowPos），
        所以这里跟它保持一致。代价是没有 Aero Snap，换来的是"一定能拖"。
        """
        hwnd = self.main_hwnd()
        if not hwnd:
            log("begin_drag: 找不到主窗口句柄")
            return False
        try:
            if self.maxed:
                self._unmaximize(hwnd, follow_cursor=True)
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            self._drag_origin = (rect.left, rect.top)
            log(f"拖动开始 hwnd={hwnd} 起点=({rect.left},{rect.top})")
            return True
        except Exception as e:
            log(f"拖动初始化失败：{e}")
            return False

    def drag_to(self, dx: float, dy: float) -> bool:
        hwnd = self.main_hwnd()
        origin = self._drag_origin
        if not hwnd or not origin:
            log(f"drag_to 忽略 hwnd={hwnd} origin={origin}")
            return False
        try:
            user32.SetWindowPos(
                hwnd, 0,
                origin[0] + int(dx), origin[1] + int(dy),
                0, 0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
            return True
        except Exception as e:
            log(f"拖动失败：{e}")
            return False

    def end_drag(self) -> bool:
        self._drag_origin = None
        return True

    def begin_resize(self, direction: str) -> bool:
        """缩放开始：记下初始矩形和方向，后面按位移改四条边。"""
        hwnd = self.main_hwnd()
        if not hwnd or self.maxed:  # 最大化状态下不许拉边
            return False
        d = (direction or "").strip().lower()
        if d not in HT_DIRS:
            log(f"未知的缩放方向：{direction}")
            return False
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        self._resize_state = {
            "dir": d,
            "rect": (rect.left, rect.top, rect.right, rect.bottom),
        }
        return True

    def resize_to(self, dx: float, dy: float) -> bool:
        hwnd = self.main_hwnd()
        st = self._resize_state
        if not hwnd or not st:
            return False
        left, top, right, bottom = st["rect"]
        d = st["dir"]
        dx, dy = int(dx), int(dy)
        if "w" in d:
            left += dx
        if "e" in d:
            right += dx
        if "n" in d:
            top += dy
        if "s" in d:
            bottom += dy

        # 最小尺寸得自己守：FormBorderStyle.None 之后 WinForms 的 MinimumSize
        # 只在系统拖边循环里生效，SetWindowPos 是绕过它的。
        min_w, min_h = self.min_size
        if right - left < min_w:
            if "w" in d:
                left = right - min_w
            else:
                right = left + min_w
        if bottom - top < min_h:
            if "n" in d:
                top = bottom - min_h
            else:
                bottom = top + min_h

        try:
            user32.SetWindowPos(
                hwnd, 0, left, top, right - left, bottom - top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
            return True
        except Exception as e:
            log(f"缩放失败：{e}")
            return False

    def end_resize(self) -> bool:
        self._resize_state = None
        return True

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
            # 静默启动时窗口还没建。pywebview.start() 只能跑在主线程上，
            # 这里把请求交给主线程，由它建窗口并起 GUI 循环。
            log("show_main: 主窗口还没建，转交主线程创建")
            self._window_show = True
            self._window_requested.set()
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

        # 页面内淡入。托盘/唤醒口进来时是子线程，evaluate_js 可能撞上
        # WebView2 的 COM 线程限制；call_main_js 内部已兜底，失败只是没动画。
        self.call_main_js("flashIn", {})

    def call_main_js(self, fn: str, arg) -> None:
        if self.main is None or not self._page_ready:
            # 窗口是懒创建的，页面可能还没 load 完（比如圆环里点「日志」）。
            # 先排队，mark_page_ready 时统一补发，否则这一下会静默丢掉。
            self._pending_js.append((fn, arg))
            return
        self._eval_main_js(fn, arg)

    def _eval_main_js(self, fn: str, arg) -> None:
        try:
            self.main.evaluate_js(
                "window.__zenDock && window.__zenDock.%s(%s)" % (fn, json.dumps(arg))
            )
        except Exception as e:
            log(f"调用主窗口 JS 失败：{e}")

    def mark_page_ready(self) -> None:
        self._page_ready = True
        pending, self._pending_js = self._pending_js, []
        for fn, arg in pending:
            self._eval_main_js(fn, arg)

    def wait_for_main_request(self) -> None:
        """静默启动：主线程在这里让位，直到托盘/唤醒口/圆环第一次要窗口。

        托盘（pystray）和热键（RegisterHotKey + 自己的消息循环）都是独立线程，
        所以主线程可以什么都不跑；真正要的是 pywebview.start() 必须由主线程调。
        """
        self._window_requested.wait()
        self._window_requested.clear()

    # ---- 拓展坞 ----
    def toggle_dock(self) -> None:
        log("热键触发 toggle_dock")
        try:
            if self.ring is not None and self.ring.is_open:
                self.ring.close()
            elif self.dock is not None:
                self.close_dock()
            else:
                self.open_dock()
        except Exception as e:
            log(f"切换拓展坞失败：{type(e).__name__}: {e}")

    def open_dock(self) -> None:
        # 圆环形态走分层窗口自绘：真 per-pixel alpha，第一帧就是完整 UI。
        # 面板形态还是 pywebview —— 它是规规矩矩的矩形窗口，不需要透明。
        if (read_settings().get("dockMode") or "ring") == "ring":
            self._open_ring()
            return

        if self.main is None:
            # 面板坞也要 pywebview 的 GUI 循环。静默启动下先让主线程建窗口
            # （隐藏着，不打扰），循环起来后再由 on_ready 把坞开出来。
            log("面板坞需要 GUI 循环，转交主线程创建")
            self._pending_dock = True
            self._window_show = False
            self._window_requested.set()
            return

        if self.dock is not None:
            try:
                self.dock.show()
                self.dock.restore()
            except Exception:
                pass
            return
        import webview

        w, h = DOCK_W, DOCK_H
        x, y = cursor_anchor(w, h)

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
                background_color="#0b0e14",
            )
        except Exception as e:
            log(f"打开拓展坞失败：{e}")
            self.tray.notify(f"拓展坞打不开：{e}")
            return

        self.dock = win
        win.events.closed += self._on_dock_closed
        log(f"拓展坞已打开 ({x},{y}) 形态=面板")
        threading.Thread(target=self._watch_dock_focus, args=(win,), daemon=True).start()

    # ---- 圆环坞 ----

    def _open_ring(self) -> None:
        try:
            from ring import RingDock
        except Exception as e:
            log(f"加载圆环坞失败，退回面板形态：{type(e).__name__}: {e}")
            self._open_panel_fallback()
            return

        if self.ring is None:
            self.ring = RingDock(
                port=self.port,
                on_home=self._dock_home,
                on_logs=self._dock_logs,
                on_closed=self._dock_ring_closed,
            )
        self.ring.show()

    def _open_panel_fallback(self) -> None:
        """圆环坞起不来时的兜底：临时把形态当面板处理。"""
        saved = read_settings().get("dockMode")
        save_setting("dockMode", "panel")
        try:
            self.open_dock()
        finally:
            save_setting("dockMode", saved or "ring")

    def _dock_home(self) -> None:
        """圆环 12 点那块「主页」：关坞之后把主窗口叫出来。

        这个回调跑在圆环窗口自己的线程里，而 pywebview 的窗口操作属于主线程，
        所以丢到短命线程里做，别阻塞消息循环。
        """
        log("坞 → 主窗口")
        threading.Thread(target=self.show_main, daemon=True).start()

    def _dock_logs(self, item_id: str) -> None:
        def work():
            self.show_main()
            time.sleep(0.25)  # 等主窗口真的露出来再切抽屉
            self.call_main_js("openDrawer", item_id)

        threading.Thread(target=work, daemon=True).start()

    def _dock_ring_closed(self) -> None:
        log("圆环坞已关闭")

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

        主窗口传 #0b0e14（= --bg）。底色和页面底色差 0，边缘过渡带自然消失。

        圆环坞不需要这一步 —— 它走的是 shell/ring.py 的分层窗口，alpha 由
        位图逐像素决定，压根没有"窗体底色"这回事。
        """
        try:
            import clr  # pythonnet：预热线程或 pywebview 已经加载过它
            clr.AddReference("System.Drawing")
            from System.Drawing import Color

            win.native.BackColor = Color.FromArgb(*rgb)
            log(f"窗体底色已设为 #{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}")
        except Exception as e:
            log(f"设置窗体底色失败（不影响使用）：{type(e).__name__}: {e}")

    def _on_dock_closed(self) -> None:
        self.dock = None
        log("拓展坞已关闭")

    def close_dock(self) -> None:
        if self.ring is not None and self.ring.is_open:
            self.ring.close(animated=False)
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
        self._window_requested.set()  # 主线程可能正卡在等窗口请求
        self.close_dock()
        # 圆环坞的窗口是常驻复用的，hide 不等于结束 —— 退出时必须真销毁，
        # 否则它的消息循环线程会一直吊着。
        if self.ring is not None:
            self.ring.destroy()
        try:
            if self.main is not None:
                self.main.destroy()
        except Exception as e:
            log(f"销毁主窗口失败：{e}")


def warm_ring_backend() -> None:
    """后台预热圆环坞的 GDI+ 栈。

    `clr.AddReference("System.Drawing")` 首次要 800ms 以上。不预热的话，用户
    第一次按热键唤坞会等整整一秒才看到东西 —— 那正是"点了没反应"的观感。
    放后台跑，等真正唤出时 `_load_gdip()` 直接命中缓存。
    """
    t0 = time.perf_counter()
    try:
        import numpy  # noqa: F401  每帧的预乘 alpha 转换要用，一起预热掉
        import ring

        ring._load_gdip()
        log(f"GDI+ 已预热（{int((time.perf_counter() - t0) * 1000)}ms）")
    except Exception as e:
        log(f"GDI+ 预热失败（不影响面板形态）：{type(e).__name__}: {e}")


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

    def build_main(show: bool) -> None:
        """建主窗口（连同 WebView2）。静默启动时留到第一次需要才调。"""
        WEBVIEW_DATA.mkdir(parents=True, exist_ok=True)
        app.main = webview.create_window(
            "Zen-Dock",
            url=f"http://{args.host}:{args.port}/",
            width=1280,
            height=860,
            min_size=(900, 600),
            background_color="#0b0e14",
            hidden=not show,
            # 主窗口也是无边框：标题栏和窗口按钮由页面自绘（panel.js 的 #titlebar），
            # 边框则内化成一圈 inset 描边，跟拓展坞的无边框风格统一。
            frameless=True,
            easy_drag=False,  # 拖动自己做，否则整页都能拖，点按钮会误拖窗口
            shadow=False,
            js_api=app.api,
        )

        def on_ready() -> None:
            """WebView2 的宿主窗口这时才真正存在，可以刷底色了。"""
            app._paint_form_backdrop(app.main, (11, 14, 20))  # #0b0e14 = --bg
            app.mark_page_ready()
            if app._flash_on_load:
                app.call_main_js("flashIn", {})
            if app._pending_dock:
                app._pending_dock = False
                app.open_dock()

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

    # 托盘、热键、圆环坞都不依赖主窗口；静默启动先把它们拉起来，
    # WebView2 那一整套（含 .NET CLR）等到第一次真正要窗口时再初始化。
    if args.hidden:
        app.tray.ensure(app)  # 没有托盘就没人能把窗口叫出来
    else:
        build_main(show=True)

    # 唤醒口要在等待之前就位，否则第二个实例起来时找不到入口
    wake_port = start_wake_server(app.show_main)
    write_instance(wake_port)
    log(f"单实例已就位，唤醒口 127.0.0.1:{wake_port}")

    app.start_hotkey()

    # 圆环坞的 GDI+ 栈独立预热：静默启动可能一整天都不建窗口，
    # 而热键随时可能唤坞，不能把预热挂在主窗口的 loaded 事件上。
    threading.Thread(target=warm_ring_backend, daemon=True).start()

    try:
        if args.auto_close:
            # 仅用于自动化验证，正式使用不会走到这里
            def _closer() -> None:
                time.sleep(args.auto_close)
                app.request_quit()

            threading.Thread(target=_closer, daemon=True).start()

        if args.hidden:
            log("静默启动：主窗口延迟到第一次需要时创建")
            app.wait_for_main_request()
            if not app.quitting:
                app._flash_on_load = bool(app._window_show)
                build_main(show=app._window_show)

        if not app.quitting:
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
    log("窗口已关闭" if app.main is not None else "主窗口未创建，直接退出")
    kill_tree(server_proc)
    log("退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
