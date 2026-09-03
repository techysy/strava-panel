#!/usr/bin/env python3
"""生成 Strava Panel 全平台应用图标 — 按 Strava 官方 SVG 徽标矢量绘制.

数据来源：Strava 官方 badges 包 `@svg/strava logo mark.svg` 中的 echelon 路径
（主峰 M11,14 L15,23 L22,23 L11,0 L0,23 L7,23 Z + 次峰 50% 透明），
按官方 App 图标风格绘制：Strava 橙 (#FC4C01) 圆角方块 + 白色 echelon。
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

# 官方 SVG echelon 路径（viewBox 内 27×40 区域, 主峰不透明 / 次峰 50%）
PEAK_MAIN = [(11, 14), (15, 23), (22, 23), (11, 0), (0, 23), (7, 23)]
PEAK_SUB = [(19, 40), (11, 23), (16, 23), (19, 30), (22, 23), (27, 23)]
# SVG 源区域：translate(13,5), path 占 0..27 x 0..40
SRC_W, SRC_H = 27.0, 40.0
SRC_X, SRC_Y = 13.0, 5.0

ORANGE = (252, 76, 1, 255)        # Strava 官方 #FC4C01
WHITE = (255, 255, 255, 255)
WHITE_SUB = (255, 255, 255, 128)  # 次峰 50% 透明（对齐官方 echelon-white 半透）
TRANSPARENT = (0, 0, 0, 0)

# 圆角半径比例（fnOS/桌面 App 图标常规观感，对齐 macOS/Windows 现代风格）
CORNER_RATIO = 0.22


def draw_icon(size: int) -> Image.Image:
    """绘制 size×size 的 Strava Panel 图标（橙色圆角方块 + 白色 echelon）."""
    img = Image.new("RGBA", (size, size), TRANSPARENT)
    d = ImageDraw.Draw(img)
    radius = round(size * CORNER_RATIO)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=ORANGE)

    # echelon 在方块中的安全区：左右留白 20%，垂直居中，占高 ~64%
    box_h = size * 0.64
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
