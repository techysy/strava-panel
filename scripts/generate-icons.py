#!/usr/bin/env python3
"""生成 Strava Panel fnOS 应用图标 — 官方 Strava 橙色圆角徽标.

图标源：Strava 官方图标库的 `@2x/48@2x.png`（96×96 橙色圆角六边形 + 白色/浅橙 echelon）。
用法：python3 scripts/generate-icons.py [源.png]
  默认源 = /tmp/strava-badges/@2x/48@2x.png（可改成你的官方图标库路径）。
说明：fnOS 应用图标需 ICON.PNG(64) + ICON_256.PNG(256) + app/ui/images/icon_{64,128,256}.png。
"""
import sys
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/strava-badges/@2x/48@2x.png"

def main():
    src = Image.open(SRC).convert("RGBA")
    print(f"源: {SRC} size={src.size}")
    files = [
        (64, "ICON.PNG"),
        (256, "ICON_256.PNG"),
        (64, "app/ui/images/icon_64.png"),
        (128, "app/ui/images/icon_128.png"),
        (256, "app/ui/images/icon_256.png"),
    ]
    for s, path in files:
        img = src.resize((s, s), Image.LANCZOS)
        img.save(path)
        print("saved", path, s)

if __name__ == "__main__":
    main()
