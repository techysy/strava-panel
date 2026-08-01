#!/usr/bin/env python3
"""生成 Strava Panel fnOS 应用图标 — 橙色渐变 + 白色 S + 骑行元素, 小圆角对齐 fnOS 规范(~3%)"""
from PIL import Image, ImageDraw
import math

C1, C2 = (0xFC,0x4C,0x02), (0xE8,0x43,0x00)  # Strava 橙

def lerp(a,b,t): return int(a+(b-a)*t)

def make_icon(size):
    rad = int(size*0.03)  # 小圆角对齐 fnOS
    img = Image.new("RGBA",(size,size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        for x in range(size):
            t=(x+y)/(2*size-2)
            d.point((x,y),fill=(lerp(C1[0],C2[0],t),lerp(C1[1],C2[1],t),lerp(C1[2],C2[2],t),255))
    mask = Image.new("L",(size,size),0)
    dm = ImageDraw.Draw(mask)
    dm.rounded_rectangle([0,0,size-1,size-1],radius=rad,fill=255)
    img.putalpha(mask)
    # 白色 "S" + 骑行三角 (Strava logo 风格: 两个叠加三角)
    d = ImageDraw.Draw(img)
    cx, cy = size*0.5, size*0.58
    w = size*0.30
    # Strava logo = "S" 形折线
    pts = [
        (cx-w/2, cy-w*0.15),  # 左中
        (cx, cy-w*0.15),
        (cx, cy-w*0.55),      # 上
        (cx-w*0.30, cy+w*0.30),
        (cx+w*0.30, cy+w*0.30),
    ]
    d.line(pts, fill=(255,255,255,255), width=max(3,int(size*0.09)), joint="curve")
    return img

for s,path in [(64,"ICON.PNG"),(256,"ICON_256.PNG"),
               (64,"app/ui/images/icon_64.png"),(128,"app/ui/images/icon_128.png"),(256,"app/ui/images/icon_256.png")]:
    make_icon(s).save(path)
    print("saved",path)
