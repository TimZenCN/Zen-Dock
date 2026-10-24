"""Zen-Dock 桌面窗口外壳。

用法（正常从 zen-dock-window.bat 启动，不用手敲）：
    .venv\\Scripts\\pythonw.exe shell\\desktop.py
    .venv\\Scripts\\pythonw.exe shell\\desktop.py --port 7718

行为：
1. 探测 127.0.0.1:<port>。已经在跑就直接连过去，不碰它。
2. 没在跑就拉起 `node index.mjs --no-open`，等端口就绪。
3. 开窗口。窗口关掉之后，只清理自己拉起来的那个 node 进程。

为什么显式指定 storage_path：pywebview 默认 private_mode=True，用临时目录做
WebView2 的 user data folder，在某些会话里初始化会直接抛 E_ABORT (0x80004004)。
固定到项目内目录就正常了。
"""

from __future__ import annotations

import argparse
import ctypes
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHELL = ROOT / "shell"
ICON = SHELL / "icon.ico"
WEBVIEW_DATA = ROOT / ".webview"
SERVER_LOG = SHELL / "server.log"
DESKTOP_LOG = SHELL / "desktop.log"

IS_WIN = os.name == "nt"
NO_WINDOW = subprocess.CREATE_NO_WINDOW if IS_WIN else 0


def setup_logging() -> None:
    """pythonw 下没有控制台。

    注意：sys.stdout 不一定是 None——有时是个存在但写不进去的对象，
    所以不能只判 None，得真的试着写一次。
    """
    if sys.stdout is not None:
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


def main() -> int:
    setup_logging()

    parser = argparse.ArgumentParser(description="Zen-Dock 桌面窗口")
    parser.add_argument("--port", type=int, default=7717)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--auto-close", type=float, default=0, help=argparse.SUPPRESS)
    args = parser.parse_args()

    log("=" * 50)
    log("Zen-Dock desktop shell")

    import webview  # 放这里，出错时日志已经就绪

    server_proc = None
    if port_open(args.port):
        log(f"端口 {args.port} 已有服务在跑，直接连过去")
    else:
        server_proc = start_server(args.port)
        if server_proc is None:
            return 1

    WEBVIEW_DATA.mkdir(parents=True, exist_ok=True)

    webview.create_window(
        "Zen-Dock",
        url=f"http://{args.host}:{args.port}/",
        width=1280,
        height=860,
        min_size=(900, 600),
        background_color="#0b0e14",
    )

    try:
        if args.auto_close:
            # 仅用于自动化验证，正式使用不会走到这里
            def _closer() -> None:
                time.sleep(args.auto_close)
                for w in webview.windows:
                    try:
                        w.destroy()
                    except Exception:
                        pass

            threading.Thread(target=_closer, daemon=True).start()

        webview.start(
            gui="edgechromium",
            private_mode=False,
            storage_path=str(WEBVIEW_DATA),
            icon=str(ICON) if ICON.exists() else None,
        )
    except Exception as e:
        alert("Zen-Dock", f"窗口启动失败：\n{type(e).__name__}: {e}")
        kill_tree(server_proc)
        return 1

    log("窗口已关闭")
    kill_tree(server_proc)
    log("退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
