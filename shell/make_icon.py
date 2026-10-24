"""生成 Zen-Dock 窗口图标。

一次性工具，改了配色或字形重跑一次即可：
    .venv/Scripts/python.exe shell/make_icon.py
产物：shell/icon.ico（多尺寸）+ shell/icon.png（预览用）
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 512
BG = (18, 22, 31, 255)  # #12161f
BORDER = (47, 57, 73, 255)  # #2f3949
ACCENT = (63, 185, 80, 255)  # #3fb950

OUT_DIR = Path(__file__).resolve().parent


def pick_font(size: int) -> ImageFont.FreeTypeFont:
    for name in ("arialbd.ttf", "segoeuib.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def build() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle(
        [10, 10, SIZE - 10, SIZE - 10],
        radius=108,
        fill=BG,
        outline=BORDER,
        width=8,
    )

    font = pick_font(330)
    text = "Z"
    left, top, right, bottom = d.textbbox((0, 0), text, font=font)
    w, h = right - left, bottom - top
    d.text(
        ((SIZE - w) / 2 - left, (SIZE - h) / 2 - top - 6),
        text,
        font=font,
        fill=ACCENT,
    )
    return img


def main() -> None:
    img = build()
    img.save(OUT_DIR / "icon.png")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[-1].save(OUT_DIR / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes])

    print(f"icon.png  {OUT_DIR / 'icon.png'}")
    print(f"icon.ico  {OUT_DIR / 'icon.ico'}  ({', '.join(str(s) for s in sizes)})")


if __name__ == "__main__":
    main()
