"""全局热键：RegisterHotKey + 独立消息循环。

为什么不用键盘钩子（WH_KEYBOARD_LL）：钩子会拦下所有按键，杀软直接当键盘记录器
看；而且没法做冲突检测。RegisterHotKey 是系统官方接口，被占用会明确返回失败，
正好对上「冲突检测」这个需求。

约束：必须带至少一个修饰键。纯字母热键会跟正常打字冲突，这里直接拒掉。
"""

from __future__ import annotations

import ctypes
import threading
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012

user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_uint, ctypes.c_uint]
user32.RegisterHotKey.restype = wintypes.BOOL
user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
user32.UnregisterHotKey.restype = wintypes.BOOL
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, ctypes.c_uint, ctypes.c_uint]
user32.GetMessageW.restype = ctypes.c_int
user32.PostThreadMessageW.argtypes = [wintypes.DWORD, ctypes.c_uint, wintypes.WPARAM, wintypes.LPARAM]
user32.PostThreadMessageW.restype = wintypes.BOOL

HOTKEY_ID = 0xB10C

VK = {
    "space": 0x20,
    "tab": 0x09,
    "esc": 0x1B,
    "enter": 0x0D,
    "backspace": 0x08,
    "delete": 0x2E,
    "insert": 0x2D,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "`": 0xC0,
    "-": 0xBD,
    "=": 0xBB,
    "[": 0xDB,
    "]": 0xDD,
    ";": 0xBA,
    "'": 0xDE,
    ",": 0xBC,
    ".": 0xBE,
    "/": 0xBF,
    "\\": 0xDC,
}
for _i in range(1, 25):
    VK[f"f{_i}"] = 0x6F + _i
for _c in "abcdefghijklmnopqrstuvwxyz":
    VK[_c] = ord(_c.upper())
for _d in "0123456789":
    VK[_d] = ord(_d)

MOD_NAMES = {
    "alt": MOD_ALT,
    "ctrl": MOD_CONTROL,
    "control": MOD_CONTROL,
    "shift": MOD_SHIFT,
    "win": MOD_WIN,
    "super": MOD_WIN,
    "meta": MOD_WIN,
}


def parse_hotkey(spec: str):
    """'alt+x' → (mods, vk, 'alt+x')。不合法就抛 ValueError。"""
    parts = [p.strip().lower() for p in str(spec).replace("+", " ").split() if p.strip()]
    if not parts:
        raise ValueError("快捷键是空的")

    mods = 0
    key = None
    for p in parts:
        if p in MOD_NAMES:
            mods |= MOD_NAMES[p]
        elif key is None:
            key = p
        else:
            raise ValueError(f"只能有一个主键，收到多个：{parts}")

    if key is None:
        raise ValueError("缺少主键，比如 alt+x")
    if key not in VK:
        raise ValueError(f"不认识这个键：{key}")
    if mods == 0:
        raise ValueError("必须带至少一个修饰键（alt / ctrl / shift / win）")

    order = []
    if mods & MOD_CONTROL:
        order.append("ctrl")
    if mods & MOD_ALT:
        order.append("alt")
    if mods & MOD_SHIFT:
        order.append("shift")
    if mods & MOD_WIN:
        order.append("win")
    order.append(key)
    return mods, VK[key], "+".join(order)


class HotkeyListener:
    """在独立线程里跑消息循环接 WM_HOTKEY。

    hWnd 传 NULL，消息投递到注册线程自己的队列，所以注册和循环必须在同一线程。
    """

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._thread_id: int | None = None
        self._running = False
        self._callback = None
        self._spec = None
        self._ready = threading.Event()
        self._error: Exception | None = None
        self._actual = None

    @property
    def spec(self) -> str | None:
        return self._actual

    def start(self, spec: str, callback) -> str:
        """注册并开始监听。失败抛异常（通常是被占用）。"""
        self.stop()
        self._spec = spec
        self._callback = callback
        self._error = None
        self._actual = None
        self._ready.clear()
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

        if not self._ready.wait(timeout=3):
            self._running = False
            raise RuntimeError("热键线程启动超时")
        if self._error is not None:
            raise self._error
        return self._actual

    def _loop(self) -> None:
        self._thread_id = kernel32.GetCurrentThreadId()
        try:
            mods, vk, norm = parse_hotkey(self._spec)
        except Exception as e:
            self._error = e
            self._ready.set()
            return

        if not user32.RegisterHotKey(None, HOTKEY_ID, mods, vk):
            err = ctypes.get_last_error()
            self._error = RuntimeError(f"注册失败（错误码 {err}），这个组合可能已被别的程序占用")
            self._ready.set()
            return

        self._actual = norm
        self._ready.set()

        msg = wintypes.MSG()
        while self._running:
            r = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if r <= 0:
                break
            if msg.message == WM_HOTKEY and msg.wParam == HOTKEY_ID:
                try:
                    if self._callback:
                        self._callback()
                except Exception as e:
                    # 回调在消息线程里跑，异常不能吞——否则热键"没反应"根本查不出原因
                    print(f"[hotkey] 回调异常：{type(e).__name__}: {e}", flush=True)

        user32.UnregisterHotKey(None, HOTKEY_ID)

    def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        if self._thread_id:
            user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._thread = None
        self._thread_id = None
