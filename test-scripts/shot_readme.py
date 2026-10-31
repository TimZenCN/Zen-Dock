"""生成 README 用的配图，输出到 docs/images/。

跟 snap_panel.py 的区别：
- 用通用示例数据（snap_panel 里是真实项目名，不能进公开仓库）
- 自动裁掉底部空白（页面内容撑不满 860px）
- 圆环坞用离屏渲染图合成到深色底，不截真实桌面

用法：python test-scripts/shot_readme.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import snap_panel as sp  # noqa: E402
from PIL import Image  # noqa: E402

OUT_DIR = sp.ROOT / "docs" / "images"
TMP_DIR = sp.ROOT / "test-scripts"

# 通用示例：覆盖运行中 / 已停止 / 失败 / 页面 / 脚本五种状态
sp.ITEMS = [
    {
        "id": "api", "kind": "service", "name": "API Server", "port": 8080,
        "url": "http://127.0.0.1:8080/",
        "runtime": {"status": "running", "pid": 4820, "startedAt": 0, "port": 8080},
    },
    {
        "id": "web", "kind": "service", "name": "Web App", "port": 3000,
        "runtime": {"status": "stopped", "pid": None, "exitCode": 0},
    },
    {
        "id": "docs", "kind": "page", "name": "Docs", "dir": "./sites/demo",
        "runtime": {"status": "stopped"},
    },
    {
        "id": "build", "kind": "script", "name": "Build Script", "shell": "powershell",
        "path": "D:/work/build.ps1",
        "runtime": {"status": "idle", "exitCode": 0},
    },
    {
        "id": "deploy", "kind": "script", "name": "Deploy Script", "shell": "powershell",
        "path": "D:/work/deploy.ps1",
        "runtime": {"status": "crashed", "exitCode": 1},
    },
    {
        "id": "backup", "kind": "script", "name": "Backup Job", "shell": "python",
        "path": "D:/work/backup.py",
        "runtime": {"status": "running"},
    },
]

BG = (11, 14, 20)          # --bg #0b0e14
PANEL_BG = (18, 22, 31)    # --panel #12161f
EDGE = (47, 57, 73)        # --line2 #2f3949，body::after 的 inset 描边


def trim_bottom(path: Path, min_height: int = 360, pad: int = 22) -> int:
    """裁掉底部没有内容的空白。

    判定标准：整行都是页面底色。三种颜色都算底色：--bg、--panel，
    以及四周那圈 1px 描边（它出现在每一行的最外侧，不排除的话永远裁不动）。
    """
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    backgrounds = {BG, PANEL_BG, EDGE}

    bottom = h - 1
    while bottom > min_height:
        row_blank = True
        # 跳过最外 2px：body::after 的 inset 描边在每一行都存在，
        # 不排除的话任何一行都会被判成"有内容"
        for x in range(2, w - 2, 6):
            if px[x, bottom] not in backgrounds:
                row_blank = False
                break
        if not row_blank:
            break
        bottom -= 1

    new_h = min(h, bottom + pad)
    if new_h < h:
        im.crop((0, 0, w, new_h)).save(path)
    return new_h


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


def make_ring() -> Path:
    """圆环坞：离屏渲染成透明 PNG，再合成到深色底。

    不能用 build_slots()——它从 /api/state 拉真实数据，会把本机的项目名
    画进配图。这里手动构造通用示例。
    """
    sys.path.insert(0, str(sp.ROOT / "shell"))
    import ring  # noqa: E402

    ring._load_gdip()
    dock = ring.RingDock(port=0)
    dock._slots = [
        ring.Slot("home", "主页", "home", is_home=True),
        ring.Slot("api", "API Server", "service", status="running"),
        ring.Slot("web", "Web App", "service", status="stopped"),
        ring.Slot("docs", "Docs", "page", status="stopped"),
        # 圆环上每块只有 5 个汉字宽，长名字会被截断 —— 这里用 shortName
        ring.Slot("build", "Build", "script", status="idle"),
        ring.Slot("deploy", "Deploy", "script", status="crashed"),
        ring.Slot("backup", "Backup", "script", status="running"),
        ring.Slot("notes", "Notes", "page", status="stopped"),
    ]
    dock._count = len(dock._slots)
    dock._scale = 1.0
    dock._w = dock._h = ring.RING_W
    dock._phase = "idle"
    dock._hover = -1
    dock.hwnd = 1  # 让 _render 不因为"没窗口"直接返回
    dock._commit = lambda alpha=1.0: None  # 只留位图，不提交到窗口

    dock._ensure_surface()
    dock._render()

    from System.Drawing.Imaging import ImageFormat

    raw = TMP_DIR / "ring-readme-raw.png"
    dock._bitmap.Save(str(raw), ImageFormat.Png)

    ring_im = Image.open(raw).convert("RGBA")
    pad = 56
    canvas = Image.new("RGB", (ring_im.width + pad * 2, ring_im.height + pad * 2), BG)
    canvas.paste(ring_im, (pad, pad), ring_im)
    out = OUT_DIR / "ring.png"
    canvas.save(out)
    return out


def main() -> int:
    if not sp.CHROME.exists():
        print("找不到 Chrome:", sp.CHROME)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sp.OUT = TMP_DIR

    jobs = [
        # main 是纯网格页，截高了再裁；settings / about 有全高抽屉，
        # 底部行本身就有遮罩色 + 抽屉色两种，裁不动，只能按内容高度截
        ("main", "", 860),
        ("settings", open_pane("dock"), 640),
        ("about", open_pane("about"), 860),
    ]

    for name, extra, height in jobs:
        page = sp.build(name, extra)
        raw = TMP_DIR / f"readme_{name}.png"
        sp.shoot(page, raw, height)
        final = OUT_DIR / f"{name}.png"
        raw.replace(final)
        h = trim_bottom(final)
        size = final.stat().st_size
        width = Image.open(final).width
        print(f"  {name:9} -> docs/images/{final.name}  {width}x{h}  {size // 1024}KB")

    ring_png = make_ring()
    print(f"  ring      -> docs/images/ring.png  {ring_png.stat().st_size // 1024}KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
