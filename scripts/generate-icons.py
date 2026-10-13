#!/usr/bin/env python3
"""生成 Strava Panel 全平台应用图标 — 按 Strava 官方徽标矢量绘制.

徽标路径数据：simple-icons 收录的 Strava 官方 logomark（viewBox 0 0 24 24，
上左大 echelon + 右下小 echelon，与 www/favicon.svg、面板 header logo 同源），
按官方 App 图标风格绘制：Strava 橙 (#FC5200) 圆角方块 + 白色 echelon。
矢量绘制，任意分辨率无损，不依赖位图源。

用法：python3 scripts/generate-icons.py
产出：
  fnOS:    fnos-packaging/ICON.PNG(64) fnos-packaging/ICON_256.PNG(256)
         fnos-packaging/app/ui/images/icon_{64,128,256}.png
  desktop: desktop/icon.png(512) desktop/icon.ico(16-256 多尺寸)
  cli:     cli/src/tray/icon.png(64) cli/src/tray/icon.ico(16-256 多尺寸)
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

# 官方 echelon 路径（simple-icons Strava, viewBox 0 0 24 24, 已展开为多边形顶点）
PEAK_MAIN = [  # 上左大 echelon
    (10.463, 8.229), (13.299, 13.827), (17.471, 13.827),
    (10.463, 0), (3.463, 13.828), (7.632, 13.828),
]
PEAK_SUB = [   # 右下小 echelon
    (15.387, 17.944), (13.298, 13.828), (10.233, 13.828),
    (15.387, 24), (20.537, 13.828), (17.471, 13.828),
]
SRC_W, SRC_H = 24.0, 24.0
SRC_X, SRC_Y = 0.0, 0.0

ORANGE = (252, 82, 0, 255)        # Strava 官方橙 #FC5200（与 favicon/header 一致）
WHITE = (255, 255, 255, 255)
WHITE_SUB = WHITE                 # 官方 logomark 单色，两 echelon 同为实白
TRANSPARENT = (0, 0, 0, 0)

# 圆角半径比例（fnOS/桌面 App 图标常规观感，对齐 macOS/Windows 现代风格）
CORNER_RATIO = 0.22


def draw_icon(size: int) -> Image.Image:
    """绘制 size×size 的 Strava Panel 图标（橙色圆角方块 + 白色 echelon）."""
    img = Image.new("RGBA", (size, size), TRANSPARENT)
    d = ImageDraw.Draw(img)
    radius = round(size * CORNER_RATIO)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=ORANGE)

    # 徽标在方块中的安全区：居中留白，徽标(正方形源)占高 ~62%
    box_h = size * 0.62
    box_w = SRC_W / SRC_H * box_h
    x0 = (size - box_w) / 2
    y0 = (size - box_h) / 2

    def scale(pt):
        return (x0 + pt[0] / SRC_W * box_w, y0 + pt[1] / SRC_H * box_h)

    # 次峰先画（在主峰下层,主峰覆盖其上部)
    d.polygon([scale(p) for p in PEAK_SUB], fill=WHITE_SUB)
    d.polygon([scale(p) for p in PEAK_MAIN], fill=WHITE)
    return img


def save_ico(img: Image.Image, path: Path):
    """多尺寸 ico（含 16/24/32/48/64/128/256）."""
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="ICO", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    print("saved", path.relative_to(ROOT))


def save_png(img: Image.Image, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    print("saved", path.relative_to(ROOT), img.size[0])


def main():
    # 高分辨率母版 → 各尺寸 LANCZOS 缩
    master = draw_icon(512)

    # fnOS 应用图标
    for s, rel in [
        (64, "fnos-packaging/ICON.PNG"),
        (256, "fnos-packaging/ICON_256.PNG"),
        (64, "fnos-packaging/app/ui/images/icon_64.png"),
        (128, "fnos-packaging/app/ui/images/icon_128.png"),
        (256, "fnos-packaging/app/ui/images/icon_256.png"),
    ]:
        save_png(master.resize((s, s), Image.LANCZOS), ROOT / rel)

    # desktop / cli 壳图标
    save_png(master, ROOT / "desktop" / "icon.png")
    save_ico(master, ROOT / "desktop" / "icon.ico")
    save_png(master.resize((64, 64), Image.LANCZOS), ROOT / "cli" / "src" / "tray" / "icon.png")
    save_ico(master, ROOT / "cli" / "src" / "tray" / "icon.ico")


if __name__ == "__main__":
    main()
