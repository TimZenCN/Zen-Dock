"""把 renderPanel() 导成静态 HTML，配 mock 数据，用 Chrome headless 截图。

比在 WebView2 里模拟点击可靠得多：不依赖焦点、不被别的窗口遮挡。
用法：python test-scripts/snap_panel.py [settings]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test-scripts"
CHROME = Path("C:/Program Files/Google/Chrome/Application/chrome.exe")

ITEMS = [
    {
        "id": "relay", "kind": "service", "name": "Provider Relay", "port": 8787,
        "url": "http://127.0.0.1:8787/__relay/",
        "runtime": {"status": "running", "pid": 1234, "startedAt": 0, "port": 8787},
    },
    {
        "id": "dsh-web", "kind": "service", "name": "DSH Web", "port": 3080,
        "runtime": {"status": "stopped", "pid": None, "exitCode": 0},
    },
    {
        "id": "relay-ps", "kind": "script", "name": "Relay 启动脚本", "shell": "powershell",
        "path": "M:/x/run-relay.ps1",
        "runtime": {"status": "idle", "exitCode": 0},
    },
    {
        "id": "liuli-engine", "kind": "script", "name": "琉璃境引擎", "shell": "powershell",
        "path": "M:/x/run_script.ps1",
        "runtime": {"status": "idle", "exitCode": 0},
    },
    {
        "id": "liuli-editor", "kind": "script", "name": "琉璃境编辑器", "shell": "powershell",
        "path": "M:/x/run_creator.ps1",
        "runtime": {"status": "crashed", "exitCode": 1},
    },
    {
        "id": "liuli-encrypt", "kind": "script", "name": "琉璃境加密工具", "shell": "powershell",
        "path": "M:/x/run_encrypt_tool.ps1",
        "runtime": {"status": "running"},
    },
    {
        "id": "demo", "kind": "page", "name": "示例页面", "dir": "./sites/demo",
        "runtime": {"status": "stopped"},
    },
]

SETTINGS = {
    "openMode": "window",
    "closeAction": "quit",
    "autoStart": False,
    "browser": "",
    "hotkey": "alt+x",
    "dockMode": "ring",
    "dockItems": ["dsh-web", "relay", "relay-ps", "liuli-engine", "liuli-editor", "liuli-encrypt", "demo"],
}

ABOUT = {
    "version": "0.1.0",
    "node": "v22.22.2",
    "pid": 10480,
    "uptime": 3725,
    "platform": "Windows_NT 10.0.19045",
    "arch": "x64",
    "host": "PC-20210911PLGE",
    "rootPath": "D:\\work\\Project\\Zen-Dock",
    "configPath": "D:\\work\\Project\\Zen-Dock\\hub.config.json",
    "logDir": "D:\\work\\Project\\Zen-Dock\\shell",
    "webview2": "145.0.3800.65",
    "pywebview": "6.2.1",
    "shellReady": True,
}

STUB = """
<script>
(function () {
  var ITEMS = %(items)s;
  var SETTINGS = %(settings)s;
  var ABOUT = %(about)s;
  function ok(data) {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(data); } });
  }
  window.fetch = function (url, opts) {
    if (url.indexOf('/api/state') >= 0) return ok({ items: ITEMS, hub: { port: 7717, host: '127.0.0.1', logLines: 500 } });
    if (url.indexOf('/api/settings') >= 0) {
      return ok({ settings: SETTINGS, autoStart: { supported: true, enabled: false, ready: true, stale: false, command: null } });
    }
    if (url.indexOf('/api/about') >= 0) return ok(ABOUT);
    if (url.indexOf('/api/browsers') >= 0) {
      return ok({ browsers: [{ id: 'chrome', name: 'Google Chrome', path: 'C:/x/chrome.exe' }], current: '' });
    }
    if (url.indexOf('/api/events') >= 0) return new Promise(function () {});
    return ok({ ok: true });
  };
  window.EventSource = function () {
    this.close = function () {};
    this.addEventListener = function () {};
  };
  %(extra)s
})();
</script>
"""


def build(mode: str, extra: str) -> Path:
    # panel.js 是 ESM，Python 导入不了，借 node 把它渲染成字符串
    res = subprocess.run(
        ["node", "-e", "import('./lib/panel.js').then(m=>process.stdout.write(m.renderPanel()))"],
        cwd=str(ROOT), capture_output=True, timeout=30,
    )
    html = res.stdout.decode("utf-8")
    if not html:
        raise RuntimeError("renderPanel 输出为空：" + res.stderr.decode("utf-8", "replace")[:300])
    stub = STUB % {
        "items": json.dumps(ITEMS, ensure_ascii=False),
        "settings": json.dumps(SETTINGS, ensure_ascii=False),
        "about": json.dumps(ABOUT, ensure_ascii=False),
        "extra": extra,
    }
    html = html.replace("<head>", "<head>" + stub, 1)
    path = OUT / f"panel_{mode}.html"
    path.write_text(html, encoding="utf-8")
    return path


def shoot(page: Path, png: Path, height: int = 860) -> None:
    subprocess.run(
        [
            str(CHROME), "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--force-device-scale-factor=1",
            f"--screenshot={png}",
            f"--window-size=1280,{height}",
            "--virtual-time-budget=6000",
            page.as_uri(),
        ],
        check=False,
        capture_output=True,
        timeout=60,
    )


def main() -> int:
    if not CHROME.exists():
        print("找不到 Chrome:", CHROME)
        return 1

    # headless 的虚拟时间不推进 CSS transition，截图会卡在滑入中途，
    # 所以截图前一律禁掉过渡/动画——这里只验布局，动效靠实际使用看。
    def open_pane(name: str) -> str:
        return (
            "document.addEventListener('DOMContentLoaded', function () {"
            "  var st = document.createElement('style');"
            "  st.textContent = '*{transition:none!important;animation:none!important}';"
            "  document.head.appendChild(st);"
            "  setTimeout(function () {"
            "    var s = document.getElementById('settingsBtn'); if (s) s.click();"
            "    setTimeout(function () {"
            f"      var b = document.querySelector('.snav button[data-pane=\\\"{name}\\\"]');"
            "      if (b) b.click();"
            "    }, 500);"
            "  }, 200);"
            "});"
        )

    jobs = [
        ("home", "", 860),
        ("settings", open_pane("general"), 860),
        ("dock", open_pane("dock"), 860),
        ("about", open_pane("about"), 860),
    ]
    for name, extra, h in jobs:
        page = build(name, extra)
        png = OUT / f"panel_{name}.png"
        shoot(page, png, h)
        size = png.stat().st_size if png.exists() else 0
        print(f"  {name:10} -> {png.name} ({size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
