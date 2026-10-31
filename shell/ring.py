"""圆环坞：Win32 分层窗口 + GDI+ 自绘。

## 为什么不用 WebView2

之前这个坞是 pywebview 开的透明窗口 + `SetWindowRgn` 裁成环形。两条硬约束
决定了它在原理上做不出真透明：

1. WebView2 的 `DefaultBackgroundColor` 只接受 alpha 0 或 255。alpha=0 时它
   拿**宿主窗口自己的像素**当背景来渲染 —— 页面里写 `background: transparent`
   混出来的是 `Form.BackColor`，不是桌面。换什么颜色都只是换个假底色。
2. `SetWindowRgn` 是 1-bit 掩码。形状内 100% 不透明、形状外 100% 透明，
   中间没有过渡。扇形边缘只能是硬阶梯，形状内部的洞和半透明都不可能。

再加上窗口是"先创建显示、后设区域、最后才拉数据渲染"，于是看到的是三层贴纸
依次贴上：矩形 → 空环 → UI。

## 现在怎么做的

`WS_EX_LAYERED` + `UpdateLayeredWindow`，提交一张 32bpp **预乘 ARGB** 位图。
每个像素自带 alpha，这是 Windows 原生的 per-pixel alpha：

- 扇形边缘由 GDI+ 抗锯齿生成，过渡带真的半透明，透出的是桌面
- 扇形之间的 5° 间隙真的透出壁纸，不是拿深色填的
- 整帧在内存里画完才 `ShowWindow`，第一帧就是动画第 0 帧，没有空环中间态
- 不启动 WebView2，热键到出现从几百毫秒降到几十毫秒

命中还是用 `SetWindowRgn`，但职责变了：**只管鼠标**，不管绘制。区域外的
点击照样穿透到桌面，环内的绘制完全由 alpha 决定。两者互不干扰。
"""

from __future__ import annotations

import ctypes
import json
import math
import threading
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "hub.config.json"
LOG_FILE = ROOT / "shell" / "desktop.log"

# ---- 几何：必须和 panel.js 的 RING_CSS / RING_JS 保持一致 ----
RING_W = RING_H = 400
CX = CY = 200.0
R_OUT, R_IN, RC = 184.0, 66.0, 10.0
CONTENT_R = (R_OUT + R_IN) / 2.0
MAX_HALF = 34.0
# 相邻扇形之间留的角度（每块各让一半）。太大文字放不下，太小会糊成一片。
SECTOR_GAP_DEG = 2.0
MAX_SLOTS = 8
HOME = "__home"

# ---- 配色：照抄 RING_CSS，改这里就等于改坞的皮肤 ----
SECTOR = "#161b26"
SECTOR_HOVER = "#1f2a3a"
SECTOR_RUNNING = "#1a2431"
SECTOR_RUNNING_HOVER = "#22303f"
SECTOR_BUSY = "#1a212e"
SECTOR_ERR = "#1e1a1c"
SECTOR_HOME = "#141c28"
SECTOR_HOME_HOVER = "#1a2433"

TEXT = "#9aa6b8"
TEXT_HOVER = "#dfe6f0"
TEXT_RUNNING = "#7ee787"
TEXT_HOME = "#7fb0e8"
TEXT_ERR = "#ff7b72"

ICO = "#7d8799"
ICO_HOVER = "#c9d4e3"
ICO_HOME = "#7fb0e8"

# ---- 动画参数：对齐 CSS 的 bloom / collapse ----
BLOOM_MS = 340
BLOOM_STAGGER_MS = 25
COLLAPSE_MS = 190
FRAME_MS = 15

# 图标按这个倍数放大。pen 宽度要除以它，否则描边会跟着变粗显得笨重。
ICON_SCALE = 1.45

# 名字最多几个汉字宽。中英文自动等效：5 个中文 ≈ 10 个英文字符。
NAME_MAX_HAN = 5

# ---- Win32 ----
user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32
winmm = ctypes.windll.winmm

WS_POPUP = 0x80000000
WS_EX_LAYERED = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TOPMOST = 0x00000008
CS_HREDRAW = 0x0002
CS_VREDRAW = 0x0001
SW_SHOWNORMAL = 1
SW_HIDE = 0
ULW_ALPHA = 0x00000002
AC_SRC_OVER = 0
AC_SRC_ALPHA = 1
DIB_RGB_COLORS = 0
BI_RGB = 0
WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_TIMER = 0x0113
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_RBUTTONDOWN = 0x0204
WM_KEYDOWN = 0x0100
WM_ACTIVATE = 0x0006
WA_INACTIVE = 0
VK_ESCAPE = 0x1B
IDC_ARROW = 32512
MONITOR_DEFAULTTONEAREST = 2
MDT_EFFECTIVE_DPI = 0
RGN_OR = 2
WINDING = 2
TIMER_ID = 1

# SetWindowPos 标志
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010

# 自定义消息：从别的线程驱动窗口线程
WM_ZD_CLOSE = 0x0400 + 17     # wparam=1 播退出动画，0 立即隐藏
WM_ZD_SHOW = 0x0400 + 18      # 再次唤出（窗口复用，不重建）
WM_ZD_DESTROY = 0x0400 + 19   # 真销毁，进程退出时用

WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_longlong, wintypes.HWND, ctypes.c_uint, ctypes.c_ulonglong, ctypes.c_longlong
)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT),
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HANDLE),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HANDLE),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", wintypes.HANDLE),
    ]


class BLENDFUNCTION(ctypes.Structure):
    # 四个字段都是 BYTE（无符号）。用 c_byte 传 255 会溢出。
    _fields_ = [
        ("BlendOp", ctypes.c_ubyte),
        ("BlendFlags", ctypes.c_ubyte),
        ("SourceConstantAlpha", ctypes.c_ubyte),
        ("AlphaFormat", ctypes.c_ubyte),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


# 64 位下指针必须显式声明 argtypes，否则 ctypes 会把句柄截成 32 位。
# 这一整块不是"防御性代码"——少设一个 restype，拿回来的句柄就是错的，
# 后面 SetWindowRgn / CombineRgn 全部静默失败。
user32.UpdateLayeredWindow.argtypes = [
    wintypes.HWND,
    wintypes.HDC,
    ctypes.POINTER(wintypes.POINT),
    ctypes.POINTER(wintypes.SIZE),
    wintypes.HDC,
    ctypes.POINTER(wintypes.POINT),
    wintypes.DWORD,
    ctypes.POINTER(BLENDFUNCTION),
    wintypes.DWORD,
]
user32.UpdateLayeredWindow.restype = wintypes.BOOL

gdi32.CreateDIBSection.argtypes = [
    wintypes.HDC,
    ctypes.POINTER(BITMAPINFO),
    wintypes.UINT,
    ctypes.POINTER(ctypes.c_void_p),
    wintypes.HANDLE,
    wintypes.DWORD,
]
gdi32.CreateDIBSection.restype = wintypes.HANDLE

user32.CreateWindowExW.argtypes = [
    wintypes.DWORD,
    wintypes.LPCWSTR,
    wintypes.LPCWSTR,
    wintypes.DWORD,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.HWND,
    wintypes.HMENU,
    wintypes.HINSTANCE,
    wintypes.LPVOID,
]
user32.CreateWindowExW.restype = wintypes.HWND

user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
user32.RegisterClassExW.restype = wintypes.WORD

user32.DefWindowProcW.argtypes = [
    wintypes.HWND,
    wintypes.UINT,
    ctypes.c_ulonglong,
    ctypes.c_longlong,
]
user32.DefWindowProcW.restype = ctypes.c_longlong

user32.GetMessageW.argtypes = [
    ctypes.POINTER(wintypes.MSG),
    wintypes.HWND,
    wintypes.UINT,
    wintypes.UINT,
]
user32.GetMessageW.restype = ctypes.c_int
user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.restype = ctypes.c_longlong
user32.PostQuitMessage.argtypes = [ctypes.c_int]

user32.PostMessageW.argtypes = [
    wintypes.HWND,
    wintypes.UINT,
    ctypes.c_ulonglong,
    ctypes.c_longlong,
]
user32.PostMessageW.restype = wintypes.BOOL
user32.SendMessageW.argtypes = [
    wintypes.HWND,
    wintypes.UINT,
    ctypes.c_ulonglong,
    ctypes.c_longlong,
]
user32.SendMessageW.restype = ctypes.c_longlong

user32.SetTimer.argtypes = [wintypes.HWND, ctypes.c_size_t, wintypes.UINT, ctypes.c_void_p]
user32.SetTimer.restype = ctypes.c_size_t
user32.KillTimer.argtypes = [wintypes.HWND, ctypes.c_size_t]
user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetFocus.argtypes = [wintypes.HWND]
user32.SetWindowRgn.argtypes = [wintypes.HWND, wintypes.HANDLE, wintypes.BOOL]
user32.SetWindowPos.argtypes = [
    wintypes.HWND,
    wintypes.HWND,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.UINT,
]
user32.SetWindowPos.restype = wintypes.BOOL
user32.GetWindowRgn.argtypes = [wintypes.HWND, wintypes.HANDLE]
user32.GetWindowRgn.restype = ctypes.c_int
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
user32.MonitorFromPoint.restype = wintypes.HANDLE
user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MONITORINFO)]
user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
user32.LoadCursorW.restype = wintypes.HANDLE

gdi32.CreatePolygonRgn.argtypes = [ctypes.POINTER(wintypes.POINT), ctypes.c_int, ctypes.c_int]
gdi32.CreatePolygonRgn.restype = wintypes.HANDLE
gdi32.CreateRectRgn.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
gdi32.CreateRectRgn.restype = wintypes.HANDLE
gdi32.CombineRgn.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE, ctypes.c_int]
gdi32.CombineRgn.restype = ctypes.c_int
gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
gdi32.SelectObject.restype = wintypes.HANDLE

kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HINSTANCE
kernel32.GetLastError.restype = wintypes.DWORD


def log(msg: str) -> None:
    try:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] [ring] {msg}\n")
    except Exception:
        pass


# ============================================================
# 几何：圆角扇形的多边形顶点
# ============================================================


def _quad_points(p0, ctrl, p1, steps=7):
    """二次贝塞尔离散，用来倒圆角。和 panel.js 的 Q 指令同一套曲线。"""
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        out.append(
            (
                u * u * p0[0] + 2 * u * t * ctrl[0] + t * t * p1[0],
                u * u * p0[1] + 2 * u * t * ctrl[1] + t * t * p1[1],
            )
        )
    return out


def sector_polygon(cx, cy, R, r, rc, a1, a2, steps=60):
    """圆角扇形的多边形顶点，角度 0 在正上方、顺时针。

    离散精度：60 段走 40° 弧，弦高误差 184*(1-cos(0.33°)) ≈ 0.003px，
    肉眼和真圆弧没有区别。用多边形而不是 GraphicsPath 的 AddArc，是为了让
    **绘制和命中区域用同一组点**，永远不会错位。
    """
    dout = math.degrees(rc / R)
    din = math.degrees(rc / r)

    def pt(rad, deg):
        a = math.radians(deg)
        return (cx + rad * math.sin(a), cy - rad * math.cos(a))

    pts = []
    for i in range(steps + 1):
        deg = (a1 + dout) + ((a2 - dout) - (a1 + dout)) * i / steps
        pts.append(pt(R, deg))
    pts += _quad_points(pt(R, a2 - dout), pt(R, a2), pt(R - rc, a2))
    pts.append(pt(r + rc, a2))
    pts += _quad_points(pt(r + rc, a2), pt(r, a2), pt(r, a2 - din))
    for i in range(steps + 1):
        deg = (a2 - din) - ((a2 - din) - (a1 + din)) * i / steps
        pts.append(pt(r, deg))
    pts += _quad_points(pt(r, a1 + din), pt(r, a1), pt(r + rc, a1))
    pts.append(pt(R - rc, a1))
    pts += _quad_points(pt(R - rc, a1), pt(R, a1), pt(R, a1 + dout))
    return pts


def apply_hit_region(hwnd, w, h, count, scale) -> bool:
    """把窗口的**鼠标命中区域**裁成 N 块扇形的并集。

    注意这只影响鼠标，不影响绘制 —— 绘制完全由分层窗口的 alpha 决定。
    环外点击因此会穿透到桌面，不会有个看不见的矩形挡着。

    区域外扩 1.5px 把抗锯齿带包进来，避免边缘那 1px 点不动。
    """
    cx, cy = w // 2, h // 2
    step = 360.0 / max(1, count)
    half = min(step / 2 - SECTOR_GAP_DEG, MAX_HALF)
    R = (R_OUT + 1.5) * scale
    r = max(2.0, (R_IN - 1.5) * scale)
    rc = RC * scale

    total = None
    try:
        for i in range(count):
            mid = i * step
            pts = sector_polygon(cx, cy, R, r, rc, mid - half, mid + half)
            n = len(pts)
            arr = (wintypes.POINT * n)()
            for j, (x, y) in enumerate(pts):
                arr[j] = wintypes.POINT(int(round(x)), int(round(y)))
            rgn = gdi32.CreatePolygonRgn(arr, n, WINDING)
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
        log(f"设置命中区域出错：{type(e).__name__}: {e}")
        return False


# ============================================================
# 配色与缓动
# ============================================================


def _rgb(hexcolor: str):
    s = hexcolor.lstrip("#")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def ease_out_back(t: float) -> float:
    """cubic-bezier(.34,1.56,.64,1) 的近似 —— 冲过头再回弹，和 CSS 一致。"""
    c1 = 1.70158
    c3 = c1 + 1
    u = t - 1
    return 1 + c3 * u * u * u + c1 * u * u


class Slot:
    __slots__ = ("id", "name", "kind", "status", "url", "is_home")

    def __init__(self, id, name, kind, status="", url="", is_home=False):
        self.id = id
        self.name = name
        self.kind = kind
        self.status = status
        self.url = url
        self.is_home = is_home


# ============================================================
# GDI+ 封装（lazy，避免没装 pythonnet 时连 import 都炸）
# ============================================================

_gdip = {}
_gdip_lock = threading.Lock()


def _load_gdip():
    if _gdip:
        return _gdip
    # 启动时的预热线程和第一次唤出的窗口线程可能同时进来。
    # clr.AddReference 不是线程安全的，必须串行。
    with _gdip_lock:
        if _gdip:
            return _gdip
        import clr

        clr.AddReference("System.Drawing")
        from System import Array
        from System.Drawing import (
            Bitmap,
            Color,
            Font,
            FontStyle,
            Graphics,
            GraphicsUnit,
            Pen,
            PointF,
            RectangleF,
            SolidBrush,
            StringAlignment,
            StringFormat,
            StringFormatFlags,
        )
        from System.Drawing.Drawing2D import GraphicsPath, LineCap, LineJoin, Matrix, SmoothingMode
        from System.Drawing.Imaging import ImageLockMode, PixelFormat

        _gdip.update(
            Array=Array,
            Bitmap=Bitmap,
            Color=Color,
            Font=Font,
            FontStyle=FontStyle,
            Graphics=Graphics,
            GraphicsPath=GraphicsPath,
            GraphicsUnit=GraphicsUnit,
            LineCap=LineCap,
            LineJoin=LineJoin,
            StringFormatFlags=StringFormatFlags,
            Pen=Pen,
            PointF=PointF,
            RectangleF=RectangleF,
            SolidBrush=SolidBrush,
            StringAlignment=StringAlignment,
            StringFormat=StringFormat,
            Matrix=Matrix,
            SmoothingMode=SmoothingMode,
            ImageLockMode=ImageLockMode,
            PixelFormat=PixelFormat,
        )
        return _gdip


def _argb(hexcolor: str, alpha: float):
    d = _load_gdip()
    r, g, b = _rgb(hexcolor)
    a = max(0, min(255, int(round(255 * alpha))))
    return d["Color"].FromArgb(a, r, g, b)


def _color(hexcolor: str):
    """不透明色。动画期间颜色不变，整帧透明度交给 SourceConstantAlpha。"""
    d = _load_gdip()
    r, g, b = _rgb(hexcolor)
    return d["Color"].FromArgb(255, r, g, b)


def _ptf(pts):
    d = _load_gdip()
    PointF = d["PointF"]
    return d["Array"][PointF]([PointF(float(x), float(y)) for x, y in pts])


def _round_rect(x, y, w, h, r):
    d = _load_gdip()
    from System.Drawing.Drawing2D import GraphicsPath

    p = GraphicsPath()
    dd = r * 2
    p.AddArc(d["RectangleF"](x, y, dd, dd), 180, 90)
    p.AddArc(d["RectangleF"](x + w - dd, y, dd, dd), 270, 90)
    p.AddArc(d["RectangleF"](x + w - dd, y + h - dd, dd, dd), 0, 90)
    p.AddArc(d["RectangleF"](x, y + h - dd, dd, dd), 90, 90)
    p.CloseFigure()
    return p


# ============================================================
# 数据
# ============================================================


def read_settings() -> dict:
    try:
        return (json.loads(CONFIG.read_text(encoding="utf-8")).get("settings") or {})
    except Exception:
        return {}


def _http(path: str, port: int, method: str = "GET", body=None, timeout: float = 1.0):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "Origin": f"http://127.0.0.1:{port}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def build_slots(port: int) -> list:
    """从 /api/state 组装坞上要显示的东西。

    主页永远在 12 点，后面按 dockItems 的顺序排。拿不到数据就退回配置里
    的 id 列表（只有名字、没有状态色），至少环是完整的，不会出现空环。
    """
    items, settings = [], {}
    try:
        data = _http("/api/state", port, timeout=0.8)
        items = data.get("items") or []
        settings = data.get("settings") or {}
    except Exception as e:
        log(f"拉状态失败，用配置兜底：{type(e).__name__}: {e}")
        settings = read_settings()
        try:
            cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
            items = [
                {"id": i.get("id"), "name": i.get("name") or i.get("id"),
                 "kind": i.get("kind", "service"), "runtime": {}}
                for i in cfg.get("items") or []
            ]
        except Exception:
            items = []

    picked = settings.get("dockItems")
    if picked is None:
        picked = [i.get("id") for i in items if i.get("enabled", True)][: MAX_SLOTS - 1]

    slots = [Slot(HOME, "主页", "home", is_home=True)]
    for sid in list(picked)[: MAX_SLOTS - 1]:
        it = next((x for x in items if x.get("id") == sid), None)
        if not it:
            continue
        rt = it.get("runtime") or {}
        slots.append(
            Slot(
                id=it.get("id"),
                name=(it.get("shortName") or it.get("name") or it.get("id") or "")[:24],
                kind=it.get("kind", "service"),
                status=rt.get("status") or "",
                url=rt.get("url") or it.get("url") or "",
            )
        )
    return slots


# ============================================================
# 坞窗口
# ============================================================


class RingDock:
    """一个分层窗口 + 自己的消息循环，跑在独立线程里。

    对外只有 show() / close() / is_open，全部线程安全（close 只 PostMessage）。
    """

    _class_name = "ZenDockRing"
    _class_atom = None

    def __init__(self, port: int, on_home=None, on_logs=None, on_closed=None):
        self.port = port
        self.on_home = on_home
        self.on_logs = on_logs
        self.on_closed = on_closed

        self.hwnd = 0
        self._thread = None
        self._slots = []
        self._count = 1
        self._hover = -1
        self._err = {}          # id -> 短消息
        self._busy = set()
        self._scale = 1.0
        self._w = RING_W
        self._h = RING_H

        self._phase = "idle"    # idle / bloom / collapse
        self._t0 = 0.0
        self._frames = []       # 每帧绘制+提交的耗时，用来诊断卡顿

        # 动画时长从配置读（设置页的滑块）。错峰和收起按同比例联动，
        # 改一个数就能整体调快调慢，不用分别调三个。
        self.bloom_ms = BLOOM_MS
        self.stagger_ms = BLOOM_STAGGER_MS
        self.collapse_ms = COLLAPSE_MS
        self._closing = False
        self._ready = False     # 焦点稳定后才会开启失焦关闭
        self._shown = False     # 当前是否可见
        self.visible = True     # 测试时可以关掉，只跑创建/绘制链路
        self.pos_override = None  # 测试时固定窗口位置，别跟着鼠标跑
        self._wndproc_ref = None
        self._memdc = 0
        self._dib = 0
        self._dib_bits = None
        self._dib_size = (0, 0)
        self._bitmap = None
        self._graphics = None

        # 绘制缓存。每帧重建 GDI+ 对象是卡顿的根源 —— 400×400 的位图上
        # 8 块扇形 × (GraphicsPath + SolidBrush + Pen + 图标路径) 就是几十个
        # .NET 对象，实测一帧要 31ms，515ms 的动画只跑得出 8 帧。
        self._paths = {}      # (idx, count) -> GraphicsPath（扇形轮廓，形状固定）
        self._brushes = {}    # hex -> SolidBrush（颜色固定，整帧 alpha 走 SourceConstantAlpha）
        self._pens = {}       # hex -> Pen
        self._icon_cache = {}  # kind -> [GraphicsPath]
        self._label_cache = {} # (id, count, raw) -> 截断后的文本
        self._budget_px = None  # 5 个汉字的宽度，第一次测量后缓存
        self._fmt = None      # 复用的 StringFormat

    # ---- 对外 ----

    def show(self) -> None:
        """唤出。窗口是常驻复用的 —— 第二次起只是重新拉数据 + 重播动画。

        为什么不每次新建窗口：GDI+ / pythonnet 的冷加载要 800ms 以上，全花在
        第一次 `clr.AddReference("System.Drawing")` 上。窗口和绘制表面留着，
        后续唤出就只剩"拉一次 state + 画一帧"，几十毫秒。
        """
        hwnd = self.hwnd
        if hwnd and self._thread and self._thread.is_alive():
            user32.PostMessageW(hwnd, WM_ZD_SHOW, 0, 0)
            return
        self._thread = threading.Thread(target=self._run, name="zd-ring", daemon=True)
        self._thread.start()

    def close(self, animated: bool = True) -> None:
        hwnd = self.hwnd
        if not hwnd or not self._shown:
            return
        try:
            user32.PostMessageW(hwnd, WM_ZD_CLOSE, 1 if animated else 0, 0)
        except Exception as e:
            log(f"请求关闭失败：{e}")

    def destroy(self) -> None:
        """真销毁。进程退出时调，否则窗口线程会吊着。"""
        hwnd = self.hwnd
        if not hwnd:
            return
        try:
            user32.PostMessageW(hwnd, WM_ZD_DESTROY, 0, 0)
        except Exception:
            pass

    @property
    def is_open(self) -> bool:
        return bool(self.hwnd) and self._shown and not self._closing

    # ---- 窗口线程 ----

    def _run(self) -> None:
        try:
            self._create()
            self._loop()
        except Exception as e:
            import traceback

            log(f"圆环坞线程异常：{type(e).__name__}: {e}")
            log(traceback.format_exc())
        finally:
            self._release()
            self.hwnd = 0
            if self.on_closed:
                try:
                    self.on_closed()
                except Exception:
                    pass

    def _create(self) -> None:
        t_start = time.perf_counter()

        # 数据先拿到，再开窗口。顺序反了就是"空环"的成因。
        self._load_anim()
        self._slots = build_slots(self.port)
        self._count = len(self._slots)

        x, y, w, h, scale = self._target_rect()
        self._scale = scale
        self._w, self._h = w, h

        hinst = kernel32.GetModuleHandleW(None)
        self._wndproc_ref = WNDPROC(self._wndproc)
        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.style = CS_HREDRAW | CS_VREDRAW
        wc.lpfnWndProc = self._wndproc_ref
        wc.hInstance = hinst
        wc.hCursor = user32.LoadCursorW(None, IDC_ARROW)
        wc.hbrBackground = None
        wc.lpszClassName = self._class_name

        if not self._class_atom:
            atom = user32.RegisterClassExW(ctypes.byref(wc))
            if not atom:
                err = kernel32.GetLastError()
                if err != 1410:  # ERROR_CLASS_ALREADY_EXISTS
                    raise OSError(f"RegisterClassExW 失败：{err}")
            RingDock._class_atom = atom or 1

        hwnd = user32.CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            self._class_name,
            # 标题故意和面板形态（"Zen-Dock 快速启动"）不同：desktop.py 用
            # FindWindow 按标题找坞窗口做失焦监控，同名会串到一起。
            "Zen-Dock 圆环坞",
            WS_POPUP,
            x, y, self._w, self._h,
            0, 0, hinst, None,
        )
        if not hwnd:
            raise OSError(f"CreateWindowExW 失败：{kernel32.GetLastError()}")
        self.hwnd = hwnd
        log(f"窗口已建 {self._w}x{self._h} @({x},{y}) scale={self._scale:.2f} 圆心目标=({x + self._w // 2},{y + self._h // 2})")

        # 命中区域只管鼠标，和绘制无关
        ok_rgn = apply_hit_region(hwnd, self._w, self._h, self._count, self._scale)
        log(f"命中区域 {'ok' if ok_rgn else '失败'}")

        # 关键顺序：先在内存里画好动画第 0 帧并提交，再显示。
        # 这样屏幕上出现的第一帧就是完整的一环，没有矩形、没有空环。
        self._phase = "bloom"
        self._t0 = time.perf_counter()
        log("开始绘制首帧")
        self._render()
        log("首帧已提交")

        if self.visible:
            user32.ShowWindow(hwnd, SW_SHOWNORMAL)
            self._shown = True

        self._start_timer()
        if self.visible:
            self._focus_async()
        log(f"唤出耗时 {(time.perf_counter() - t_start) * 1000:.0f}ms")

    def _target_rect(self):
        """按**当前**鼠标位置和所在屏 DPI 算出窗口该在哪、多大。

        每次唤出都重算 —— 窗口是常驻复用的，如果只算一次，第二次唤出会
        停在第一次的位置上（用户报了这个问题）。
        """
        pt = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        mon = user32.MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST)
        scale = self._dpi_scale(mon)
        w = max(1, int(round(RING_W * scale)))
        h = max(1, int(round(RING_H * scale)))
        if self.pos_override:
            return self.pos_override[0], self.pos_override[1], w, h, scale
        # 故意不 clamp：圆心必须和鼠标重合，贴边时宁可让窗口超出屏幕
        return pt.x - w // 2, pt.y - h // 2, w, h, scale

    def _load_anim(self) -> None:
        """从配置读动画时长。设置页改完，下次唤出就生效。

        只暴露一个"入场时长"，错峰延迟和收起时长按同比例折算 —— 用户不需要
        理解三个参数之间的关系，调一个数整体节奏就是一致的。
        """
        try:
            ms = int(read_settings().get("dockAnimMs") or BLOOM_MS)
        except Exception:
            ms = BLOOM_MS
        ms = max(100, min(800, ms))
        self.bloom_ms = ms
        self.stagger_ms = max(0, round(ms * BLOOM_STAGGER_MS / BLOOM_MS))
        self.collapse_ms = max(60, round(ms * COLLAPSE_MS / BLOOM_MS))

    def _place(self) -> None:
        """把窗口挪到当前鼠标位置，尺寸和 DPI 跟着变。"""
        x, y, w, h, scale = self._target_rect()
        if (w, h) != (self._w, self._h) or scale != self._scale:
            self._scale = scale
            self._w, self._h = w, h
        user32.SetWindowPos(
            self.hwnd, 0, x, y, self._w, self._h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )

    def _dpi_scale(self, mon) -> float:
        try:
            shcore = ctypes.windll.shcore
            dx = ctypes.c_uint()
            dy = ctypes.c_uint()
            if shcore.GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, ctypes.byref(dx), ctypes.byref(dy)) == 0:
                return max(1.0, dx.value / 96.0)
        except Exception:
            pass
        try:
            return max(1.0, user32.GetDpiForSystem() / 96.0)
        except Exception:
            return 1.0

    def _work_area(self, mon):
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(mon, ctypes.byref(mi)):
            return mi.rcWork
        return wintypes.RECT(0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1))

    def _loop(self) -> None:
        msg = wintypes.MSG()
        while self.hwnd:
            r = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if r <= 0:
                break
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    # ---- 消息处理 ----

    def _wndproc(self, hwnd, msg, wparam, lparam):
        try:
            if msg == WM_TIMER and wparam == TIMER_ID:
                self._on_tick()
                return 0
            if msg == WM_MOUSEMOVE:
                self._on_move(lparam)
                return 0
            if msg == WM_LBUTTONDOWN:
                self._on_click(lparam)
                return 0
            if msg == WM_RBUTTONDOWN:
                self._on_right(lparam)
                return 0
            if msg == WM_KEYDOWN and wparam == VK_ESCAPE:
                self._begin_close()
                return 0
            if msg == WM_ACTIVATE:
                if (wparam & 0xFFFF) == WA_INACTIVE and self._ready:
                    self._begin_close()
                return 0
            if msg == WM_ZD_CLOSE:
                if wparam:
                    self._begin_close()
                else:
                    self._hide_now()
                return 0
            if msg == WM_ZD_SHOW:
                self._resume()
                return 0
            if msg == WM_ZD_DESTROY:
                user32.DestroyWindow(hwnd)
                return 0
            if msg == WM_CLOSE:
                self._begin_close()
                return 0
            if msg == WM_DESTROY:
                self._stop_timer()
                user32.PostQuitMessage(0)
                return 0
        except Exception as e:
            log(f"窗口过程出错：{type(e).__name__}: {e}")
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _hit(self, lparam):
        """客户区坐标 → 第几块。区域已经限制了鼠标范围，这里只算角度。"""
        x = ctypes.c_short(lparam & 0xFFFF).value / self._scale
        y = ctypes.c_short((lparam >> 16) & 0xFFFF).value / self._scale
        dx = x - CX
        dy = y - CY
        r = math.hypot(dx, dy)
        if r < R_IN - 2 or r > R_OUT + 2:
            return -1
        deg = math.degrees(math.atan2(dx, -dy)) % 360.0
        step = 360.0 / max(1, self._count)
        idx = int(round(deg / step)) % self._count
        half = min(step / 2 - SECTOR_GAP_DEG, MAX_HALF)
        diff = abs(((deg - idx * step + 180) % 360) - 180)
        return idx if diff <= half + 1 else -1

    def _on_move(self, lparam):
        idx = self._hit(lparam)
        if idx != self._hover:
            self._hover = idx
            self._render()

    def _on_click(self, lparam):
        idx = self._hit(lparam)
        if idx < 0 or idx >= len(self._slots):
            return
        slot = self._slots[idx]
        if slot.is_home:
            log("点主页")
            self._begin_close(after=self.on_home)
            return
        self._activate(slot)

    def _on_right(self, lparam):
        idx = self._hit(lparam)
        if idx < 0 or idx >= len(self._slots):
            self._begin_close()
            return
        slot = self._slots[idx]
        if slot.is_home:
            self._begin_close()
            return
        self._begin_close(after=lambda: self.on_logs and self.on_logs(slot.id))

    def _activate(self, slot: Slot) -> None:
        if slot.status == "running":
            if slot.kind == "service" and slot.url:
                self._open_url(slot.url)
            else:
                self._begin_close()
            return
        if slot.status in ("starting", "stopping") or slot.id in self._busy:
            return

        self._busy.add(slot.id)
        self._hover = -1
        self._render()

        def work():
            try:
                if slot.kind == "service":
                    r = _http(f"/api/items/{slot.id}/start", self.port, "POST", {}, timeout=30)
                    rt = (r or {}).get("runtime") or {}
                    if rt.get("status") == "running":
                        self.close(animated=True)
                        return
                    self._err[slot.id] = "启动失败"
                else:
                    _http(f"/api/items/{slot.id}/run", self.port, "POST", {}, timeout=30)
                    self.close(animated=True)
                    return
            except Exception as e:
                msg = str(e)
                self._err[slot.id] = msg[:12] + ("…" if len(msg) > 12 else "")
                log(f"执行 {slot.id} 失败：{e}")
            finally:
                self._busy.discard(slot.id)
                if self.hwnd:
                    user32.PostMessageW(self.hwnd, WM_TIMER, TIMER_ID, 0)

        threading.Thread(target=work, daemon=True).start()

    def _open_url(self, url: str) -> None:
        def work():
            try:
                _http("/api/open-window", self.port, "POST", {"url": url}, timeout=8)
            except Exception as e:
                log(f"打开 {url} 失败：{e}")
            self.close(animated=True)

        threading.Thread(target=work, daemon=True).start()

    def _focus_async(self) -> None:
        """把"抢前台"丢到独立线程。

        `SetForegroundWindow` 会同步等系统的前台锁（别的程序刚被点过就要等它
        释放），实测能耗掉 140ms。这 140ms 里动画本该已经在跑了，不该被它拖住。
        所以先 ShowWindow + 启动定时器，抢焦点另开线程慢慢来。
        """

        def work():
            hwnd = self.hwnd
            if not hwnd:
                return
            try:
                user32.SetForegroundWindow(hwnd)
                user32.SetFocus(hwnd)
            except Exception:
                pass

        threading.Thread(target=work, daemon=True).start()

    def _start_timer(self) -> None:
        """开动画定时器，顺便把系统定时器精度提到 1ms。

        `SetTimer` 的默认精度是 15.6ms，而且 WM_TIMER 是低优先级消息，实测
        一帧要 30ms 才来一次 —— 渲染明明只要 8ms，动画却只有 33fps。动画
        总共 500ms 出头，这点功耗代价可以忽略。
        """
        try:
            winmm.timeBeginPeriod(1)
            self._hi_res = True
        except Exception:
            self._hi_res = False
        user32.SetTimer(self.hwnd, TIMER_ID, FRAME_MS, None)

    def _stop_timer(self) -> None:
        user32.KillTimer(self.hwnd, TIMER_ID)
        if getattr(self, "_hi_res", False):
            try:
                winmm.timeEndPeriod(1)
            except Exception:
                pass
            self._hi_res = False

    def _begin_close(self, after=None) -> None:
        if self._closing:
            return
        self._closing = True
        self._after = after
        self._phase = "collapse"
        self._t0 = time.perf_counter()
        self._start_timer()

    def _hide_now(self) -> None:
        """收工：隐藏窗口但**不销毁**，绘制表面和 GDI+ 都留着给下次用。"""
        self._stop_timer()
        self._phase = "idle"
        self._shown = False
        self._closing = False
        self._ready = False
        self._hover = -1
        user32.ShowWindow(self.hwnd, SW_HIDE)
        after = getattr(self, "_after", None)
        self._after = None
        if after:
            try:
                after()
            except Exception as e:
                log(f"关闭后回调失败：{e}")

    def _resume(self) -> None:
        """窗口复用的唤出：重拉数据、重算区域、重播 bloom，然后显示。

        顺序仍然是"先画后显"，所以不会有一帧矩形或空环。
        """
        t0 = time.perf_counter()
        try:
            # 窗口是常驻复用的，必须先挪到鼠标当前位置 —— 不挪就停在第一次
            # 唤出的地方了。尺寸也跟着鼠标所在屏的 DPI 走。
            self._place()
            t_place = time.perf_counter()

            self._load_anim()
            self._slots = build_slots(self.port)
            self._count = len(self._slots)
            t_fetch = time.perf_counter()
            self._hover = -1
            self._err.clear()
            self._busy.clear()
            self._closing = False
            self._ready = False
            self._phase = "bloom"
            self._frames = []
            self._t0 = time.perf_counter()

            apply_hit_region(self.hwnd, self._w, self._h, self._count, self._scale)
            t_region = time.perf_counter()
            self._render()
            t_render = time.perf_counter()

            user32.ShowWindow(self.hwnd, SW_SHOWNORMAL)
            self._shown = True
            self._start_timer()
            self._focus_async()
            log(
                f"复用唤出 {(time.perf_counter() - t0) * 1000:.0f}ms "
                f"(定位 {(t_place - t0) * 1000:.0f} / 拉数据 {(t_fetch - t_place) * 1000:.0f} "
                f"/ 区域 {(t_region - t_fetch) * 1000:.0f} / 绘制 {(t_render - t_region) * 1000:.0f} "
                f"/ 显示 {(time.perf_counter() - t_render) * 1000:.0f})"
            )
        except Exception as e:
            import traceback

            log(f"复用唤出失败：{type(e).__name__}: {e}")
            log(traceback.format_exc())

    def _on_tick(self) -> None:
        t_frame = time.perf_counter()
        now = t_frame
        elapsed_ms = (now - self._t0) * 1000

        if self._phase == "bloom":
            total = self.bloom_ms + self.stagger_ms * max(0, self._count - 1)
            if elapsed_ms >= total:
                self._phase = "idle"
                if not self._ready:
                    self._ready = True
                    if self._frames:
                        avg = sum(self._frames) / len(self._frames)
                        worst = max(self._frames)
                        log(
                            f"入场完成，开始监控失焦；{len(self._frames)} 帧 "
                            f"平均 {avg * 1000:.1f}ms 最慢 {worst * 1000:.1f}ms"
                        )
                    else:
                        log("入场完成，开始监控失焦")
                self._stop_timer()
                self._render()
                return
        elif self._phase == "collapse":
            if elapsed_ms >= self.collapse_ms:
                self._hide_now()
                return

        self._render()
        if len(self._frames) < 400:
            self._frames.append(time.perf_counter() - t_frame)

    # ---- 绘制 ----

    def _progress(self, idx: int) -> float:
        """返回这一块当前的缩放。透明度不在这里 —— 整帧一个 alpha 就够了。

        逐块改 alpha 意味着每帧每块都要新建带 alpha 的 SolidBrush/Pen，缓存
        全部失效。改成整帧 alpha（走 UpdateLayeredWindow 的 SourceConstantAlpha，
        零额外成本）之后，颜色在整个动画里不变，brush/pen 可以一直复用。
        """
        if self._phase == "idle":
            return 1.0
        elapsed = (time.perf_counter() - self._t0) * 1000
        if self._phase == "bloom":
            local = (elapsed - idx * self.stagger_ms) / self.bloom_ms
            if local <= 0:
                return 0.0
            return 0.25 + 0.75 * ease_out_back(min(1.0, local))
        # collapse：反向收缩，整体同时进行
        local = min(1.0, elapsed / self.collapse_ms)
        return 1.0 - 0.7 * (local * local)  # easeInQuad，贴近 cubic-bezier(.4,0,.9,.4)

    def _global_alpha(self) -> float:
        """整帧透明度。bloom 前 1/3 时长淡入，collapse 全程淡出。"""
        if self._phase == "idle":
            return 1.0
        elapsed = (time.perf_counter() - self._t0) * 1000
        if self._phase == "bloom":
            return min(1.0, elapsed / max(1.0, self.bloom_ms * 0.35))
        return max(0.0, 1.0 - elapsed / self.collapse_ms)

    # ---- 缓存 ----

    def _sector_path(self, idx: int):
        d = _load_gdip()
        key = (idx, self._count)
        p = self._paths.get(key)
        if p is None:
            step = 360.0 / max(1, self._count)
            half = min(step / 2 - SECTOR_GAP_DEG, MAX_HALF)
            mid = idx * step
            p = d["GraphicsPath"]()
            p.AddPolygon(_ptf(sector_polygon(CX, CY, R_OUT, R_IN, RC, mid - half, mid + half)))
            self._paths[key] = p
        return p

    def _brush(self, hexcolor: str):
        b = self._brushes.get(hexcolor)
        if b is None:
            b = _load_gdip()["SolidBrush"](_color(hexcolor))
            self._brushes[hexcolor] = b
        return b

    def _pen(self, hexcolor: str, width: float = 1.4):
        key = (hexcolor, round(width, 2))
        p = self._pens.get(key)
        if p is None:
            d = _load_gdip()
            p = d["Pen"](_color(hexcolor), width)
            p.StartCap = d["LineCap"].Round
            p.EndCap = d["LineCap"].Round
            p.LineJoin = d["LineJoin"].Round
            self._pens[key] = p
        return p

    def _icon_paths(self, kind: str):
        """图标的描边路径，按 kind 缓存。坐标以图标中心为原点。"""
        got = self._icon_cache.get(kind)
        if got is not None:
            return got
        d = _load_gdip()
        out = []
        if kind == "home":
            for dx, dy in ((-6, -6), (1, -6), (-6, 1), (1, 1)):
                out.append(_round_rect(dx, dy, 5, 5, 1))
        elif kind == "service":
            out.append(_round_rect(-7, -6, 14, 12, 2))
        elif kind == "script":
            p = d["GraphicsPath"]()
            p.AddPolygon(_ptf([(-5, -6), (5, 0), (-5, 6)]))
            p.CloseFigure()
            out.append(p)
        else:
            out.append(_round_rect(-5, -7, 10, 14, 1.5))
        self._icon_cache[kind] = out
        return out

    def _sector_color(self, slot: Slot, hovered: bool) -> str:
        if slot.is_home:
            return SECTOR_HOME_HOVER if hovered else SECTOR_HOME
        if slot.status in ("crashed", "failed") or slot.id in self._err:
            return SECTOR_ERR
        if slot.status in ("starting", "stopping") or slot.id in self._busy:
            return SECTOR_BUSY
        if slot.status == "running":
            return SECTOR_RUNNING_HOVER if hovered else SECTOR_RUNNING
        return SECTOR_HOVER if hovered else SECTOR

    def _fg_color(self, slot: Slot, hovered: bool, icon: bool) -> str:
        if slot.is_home:
            return ICO_HOME if icon else TEXT_HOME
        if slot.status in ("crashed", "failed") or slot.id in self._err:
            return TEXT_ERR
        if slot.status == "running":
            return ICO_HOVER if icon else TEXT_RUNNING
        if hovered:
            return ICO_HOVER if icon else TEXT_HOVER
        return ICO if icon else TEXT

    def _ensure_surface(self):
        """Bitmap / Graphics / DIBSection 全部复用，只按尺寸重建。"""
        d = _load_gdip()
        size = (self._w, self._h)
        if self._dib_size == size and self._bitmap is not None:
            return
        self._free_surface()

        self._bitmap = d["Bitmap"](self._w, self._h, d["PixelFormat"].Format32bppArgb)
        self._graphics = d["Graphics"].FromImage(self._bitmap)
        self._graphics.SmoothingMode = d["SmoothingMode"].AntiAlias
        try:
            from System.Drawing.Text import TextRenderingHint

            self._graphics.TextRenderingHint = TextRenderingHint.AntiAlias
        except Exception:
            pass

        hdc_screen = user32.GetDC(0)
        self._memdc = gdi32.CreateCompatibleDC(hdc_screen)
        user32.ReleaseDC(0, hdc_screen)

        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = self._w
        bmi.bmiHeader.biHeight = -self._h  # 负数 = top-down，和 Bitmap 行序一致
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = BI_RGB
        bits = ctypes.c_void_p()
        self._dib = gdi32.CreateDIBSection(
            self._memdc, ctypes.byref(bmi), DIB_RGB_COLORS, ctypes.byref(bits), None, 0
        )
        if not self._dib:
            raise OSError("CreateDIBSection 失败")
        self._dib_bits = bits
        self._dib_size = size
        log(f"绘制表面已建 {self._w}x{self._h}")

    def _free_surface(self):
        try:
            if self._dib:
                gdi32.DeleteObject(self._dib)
                self._dib = 0
            if self._memdc:
                gdi32.DeleteDC(self._memdc)
                self._memdc = 0
            if self._graphics is not None:
                self._graphics.Dispose()
                self._graphics = None
            if self._bitmap is not None:
                self._bitmap.Dispose()
                self._bitmap = None
        except Exception:
            pass
        self._dib_bits = None
        self._dib_size = (0, 0)

    def _render(self) -> None:
        hwnd = self.hwnd
        if not hwnd:
            return
        d = _load_gdip()
        self._ensure_surface()
        g = self._graphics

        g.ResetTransform()
        g.Clear(d["Color"].Transparent)
        g.ScaleTransform(self._scale, self._scale)

        for i, slot in enumerate(self._slots):
            s = self._progress(i)
            if s <= 0.002:
                continue
            self._draw_slot(g, slot, i, s, i == self._hover)

        g.ResetTransform()
        self._commit(self._global_alpha())

    def _draw_slot(self, g, slot, idx, s, hovered) -> None:
        step = 360.0 / max(1, self._count)
        mid = idx * step
        brush = self._brush(self._sector_color(slot, hovered))
        path = self._sector_path(idx)

        state = g.Save()
        try:
            g.TranslateTransform(CX, CY)
            g.ScaleTransform(s, s)
            g.TranslateTransform(-CX, -CY)
            g.FillPath(brush, path)

            pos = (
                CX + CONTENT_R * math.sin(math.radians(mid)),
                CY - CONTENT_R * math.cos(math.radians(mid)),
            )
            g.TranslateTransform(pos[0], pos[1])

            self._draw_icon(g, slot, hovered)
            self._draw_label(g, slot, hovered)
        finally:
            g.Restore(state)

    def _draw_icon(self, g, slot, hovered) -> None:
        # 放大后 pen 会跟着变粗，所以宽度先除掉倍数，缩放回来正好还是 1.4px
        pen = self._pen(self._fg_color(slot, hovered, icon=True), 1.4 / ICON_SCALE)
        kind = "home" if slot.is_home else slot.kind
        state = g.Save()
        try:
            g.TranslateTransform(0, -13)
            g.ScaleTransform(ICON_SCALE, ICON_SCALE)
            for p in self._icon_paths(kind):
                g.DrawPath(pen, p)
            if kind == "service":
                g.DrawLine(pen, -7.0, -2.0, 7.0, -2.0)
            elif kind not in ("home", "script"):
                g.DrawLine(pen, -2.5, -3.0, 2.5, -3.0)
                g.DrawLine(pen, -2.5, 0.5, 2.5, 0.5)
        finally:
            g.Restore(state)

    def _string_format(self):
        if self._fmt is None:
            d = _load_gdip()
            fmt = d["StringFormat"].GenericTypographic
            fmt.Alignment = d["StringAlignment"].Center
            fmt.LineAlignment = d["StringAlignment"].Center
            fmt.FormatFlags = d["StringFormatFlags"].NoWrap
            self._fmt = fmt
        return self._fmt

    def _label_text(self, slot) -> str:
        """截断后的显示文本，缓存起来。

        两道尺子，先按字数再按像素：
        1. **字数**：中文算 2 单位、其他算 1 单位，上限 5 个汉字（10 单位）。
           这是用户要的硬规则 —— 不能让 6 个汉字靠"像素刚好放得下"就全显示。
        2. **像素**：字数过关但字形偏宽的（比如全大写的英文），再用弧长砍。
        以前每帧都 MeasureString 一遍，七字的中文名要循环 7 次，8 块就是
        几十次测量，比画扇形本身还贵。现在只算一次，结果进缓存。
        """
        raw = self._err.get(slot.id) or slot.name or slot.id or ""
        key = (slot.id, self._count, raw)
        got = self._label_cache.get(key)
        if got is not None:
            return got

        d = _load_gdip()
        g = self._graphics
        fmt = self._string_format()
        font = self._font()
        pt = d["PointF"](0.0, 0.0)

        def width(t):
            try:
                return g.MeasureString(t, font, pt, fmt).Width
            except Exception:
                return 0.0

        # ---- 第一道：字数 ----
        budget_units = NAME_MAX_HAN * 2
        units = 0
        cut = ""
        for ch in raw:
            u = 2 if ord(ch) > 0x2E7F else 1
            if units + u > budget_units:
                break
            units += u
            cut += ch
        out = raw if cut == raw else cut + "…"

        # ---- 第二道：像素 ----
        # 容差 1px：预算本身就是"5 字 + 省略号"量出来的，正好等于预算的文本
        # 会因为浮点误差被判成超宽，第 5 个字就被挤掉。
        limit = self._label_width() + 1.0
        while out.endswith("…") and len(out) > 1 and width(out) > limit:
            out = out[:-2] + "…"

        self._label_cache[key] = out
        return out

    def _label_width(self) -> float:
        """文字可用的最大宽度：弧长和「5 个汉字」取更小的那个。

        用 5 个汉字的**实际像素宽度**当尺子，而不是数字符 —— 这样中英文自动
        等效：10 个英文字符和 5 个汉字占同样宽，换字号也不用改常量。
        """
        half = min(360.0 / max(1, self._count) / 2 - SECTOR_GAP_DEG, MAX_HALF)
        # 边距只留 2px：中文省略号是全角，和汉字一样宽，留 5px 的话
        # "5 个字 + 省略号" 刚好放不下，第 5 个字会被挤掉。
        arc = (half * 2 * math.pi / 180.0) * CONTENT_R - 4.0
        return max(28.0, min(arc, self._name_budget_px()))

    def _name_budget_px(self) -> float:
        """5 个汉字 + 一个省略号的宽度。

        省略号要单独算进去 —— 否则 7 字的名字只能显示 4 字加省略号，
        看着像"明明还能再放一个字"。加上省略号之后，超长的名字能显示满
        5 个字，正好卡在用户说的"5 个字以内"。
        """
        if self._budget_px is not None:
            return self._budget_px
        g = self._graphics
        if g is None:
            return 9999.0
        d = _load_gdip()
        try:
            font = self._font()
            fmt = self._string_format()
            pt = d["PointF"](0.0, 0.0)
            w5 = g.MeasureString("永" * NAME_MAX_HAN, font, pt, fmt).Width
            ell = g.MeasureString("…", font, pt, fmt).Width
            self._budget_px = w5 + ell
        except Exception:
            self._budget_px = 9999.0
        return self._budget_px

    def _draw_label(self, g, slot, hovered) -> None:
        d = _load_gdip()
        text = self._label_text(slot)
        hexcolor = TEXT_ERR if slot.id in self._err else self._fg_color(slot, hovered, icon=False)
        max_px = self._label_width()
        g.DrawString(
            text,
            self._font(),
            self._brush(hexcolor),
            d["RectangleF"](-max_px / 2, 5.0, max_px, 20.0),
            self._string_format(),
        )

    _font_obj = None

    def _font(self):
        if RingDock._font_obj is None:
            d = _load_gdip()
            # 10pt ≈ 13.3px，加粗。11px 常规体在圆环上偏细，扫一眼分不清名字。
            RingDock._font_obj = d["Font"](
                "Microsoft YaHei UI", 10.0, d["FontStyle"].Bold, d["GraphicsUnit"].Point
            )
        return RingDock._font_obj

    def _commit(self, alpha: float = 1.0) -> None:
        """把 GDI+ 位图做成预乘 ARGB，交给 UpdateLayeredWindow。

        alpha 走 SourceConstantAlpha，由 DWM 在合成时统一乘上去 —— 比每帧
        重新计算带 alpha 的颜色便宜得多，也让 brush/pen 缓存能一直有效。
        """
        import numpy as np

        hwnd = self.hwnd
        if not hwnd:
            return
        w, h = self._w, self._h
        from System.Drawing import Rectangle

        # ReadWrite + 直接映射 LockBits 的内存做原地预乘：省掉 string_at 的
        # 640KB 复制和 out.copy() 的 640KB 分配。每帧一次，省下来很实在。
        data = self._bitmap.LockBits(
            Rectangle(0, 0, w, h),
            _load_gdip()["ImageLockMode"].ReadWrite,
            _load_gdip()["PixelFormat"].Format32bppArgb,
        )
        try:
            stride = abs(data.Stride)
            addr = data.Scan0.ToInt64()
            buf = (ctypes.c_ubyte * (stride * h)).from_address(addr)
            arr = np.ctypeslib.as_array(buf).reshape(h, stride // 4, 4)[:, :w, :]

            # UpdateLayeredWindow 要的是预乘 alpha：c' = c * a / 255
            rgb = arr[:, :, :3]
            a = arr[:, :, 3:4].astype(np.uint16)
            rgb[:] = (rgb.astype(np.uint16) * a // 255).astype(np.uint8)

            if stride == w * 4:
                ctypes.memmove(self._dib_bits.value, addr, w * h * 4)
            else:
                for row in range(h):
                    ctypes.memmove(
                        self._dib_bits.value + row * w * 4,
                        addr + row * stride,
                        w * 4,
                    )
        finally:
            self._bitmap.UnlockBits(data)

        old = gdi32.SelectObject(self._memdc, self._dib)
        try:
            hdc_screen = user32.GetDC(0)
            try:
                blend = BLENDFUNCTION(
                    AC_SRC_OVER, 0, max(0, min(255, int(round(255 * alpha)))), AC_SRC_ALPHA
                )
                # ptDst 必须给窗口当前的屏幕坐标。传 (0,0) 不是"不移动"，
                # 而是"把窗口挪到屏幕左上角"—— 每帧提交都会把它拽走一次。
                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                pt_dst = wintypes.POINT(rect.left, rect.top)
                pt_src = wintypes.POINT()
                size = wintypes.SIZE(w, h)
                ok = user32.UpdateLayeredWindow(
                    hwnd,
                    hdc_screen,
                    ctypes.byref(pt_dst),
                    ctypes.byref(size),
                    self._memdc,
                    ctypes.byref(pt_src),
                    0,
                    ctypes.byref(blend),
                    ULW_ALPHA,
                )
                if not ok:
                    log(f"commit: UpdateLayeredWindow 失败 err={kernel32.GetLastError()}")
            finally:
                user32.ReleaseDC(0, hdc_screen)
        finally:
            gdi32.SelectObject(self._memdc, old)

    def _release(self) -> None:
        self._free_surface()
        try:
            if self._font_obj is not None:
                pass  # 进程级共享，留给解释器回收
        except Exception:
            pass
