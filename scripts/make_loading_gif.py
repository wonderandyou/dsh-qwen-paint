# -*- coding: utf-8 -*-
"""
造一个「正在生成图片」的呼吸动图（16:9），供 DSH 插件在正文里引用。
============================================================================
主人 2026-10-08 的正解：「你直接把这个动画当成一张图片发出来不就完美了吗」——
所以不做 DOM 手术，改成一个**动图文件**，由模型在正文里用普通图片语法引用：
位置天然正确、随消息滚动、且完全不碰内核结构。

视觉与界面上那套保持一致：
  · 每一刻**只有一种颜色**铺满整块（不是多色渐变）
  · 颜色按色环相邻顺序轮换：红 → 橙 → 黄 → 绿 → 青 → 紫 → 红
  · 同时有明暗呼吸
  · 一道白色流光从左上扫到右下
  · 中间小字「正在生成图片」

用法：python make_loading_gif.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 960, 540          # 16:9（主人反馈 480×270 太糊 → 提到 960×540）
FRAMES = 60              # 帧数（主人反馈卡顿：28 帧≈4.5fps 太少 → 60 帧≈10fps）
DUR_MS = 100             # 每帧时长 → 一轮正好 6 秒

# ★ 用"相对脚本自身"定位（scripts/ 的上一级是插件根，assets/ 在根下）——
#   绝不写绝对路径：既会泄露打包者的 Windows 用户名，别人装上后也会写到不存在的目录。
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')
GIF_PATH = os.path.join(OUT_DIR, 'loading.gif')
WEBP_PATH = os.path.join(OUT_DIR, 'loading.webp')

# 颜色序列（色环相邻，插值才不会经过浑浊的灰）
COLORS = [
    (255, 95, 109),      # 红
    (255, 195, 113),     # 橙
    (255, 224, 102),     # 黄
    (70, 232, 145),      # 绿
    (56, 189, 248),      # 青
    (168, 85, 247),      # 紫
]


def pick_font(size):
    for path in (r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\msyhbd.ttc',
                 r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\simsun.ttc'):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return None


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def build_frames():
    font = pick_font(40)     # 分辨率翻倍，字号同步翻倍
    frames = []
    for i in range(FRAMES):
        phase = i / FRAMES

        # ---- 颜色：在 COLORS 之间平滑插值，走满一圈 ----
        pos = phase * len(COLORS)
        idx = int(pos) % len(COLORS)
        nxt = (idx + 1) % len(COLORS)
        t = pos - int(pos)
        t = t * t * (3 - 2 * t)          # smoothstep，让颜色"停一下再走"
        base = lerp(COLORS[idx], COLORS[nxt], t)

        # ---- 明暗呼吸（与颜色同周期）----
        bright = 0.72 + 0.28 * (0.5 + 0.5 * math.sin(phase * 2 * math.pi))
        base = tuple(max(0, min(255, int(round(c * bright)))) for c in base)

        img = Image.new('RGB', (W, H), base)
        draw = ImageDraw.Draw(img, 'RGBA')

        # ---- 白色流光：从左上扫到右下 ----
        cx = -W * 0.5 + phase * (W * 2.0)
        cy = -H * 0.5 + phase * (H * 2.0)
        for k in range(-68, 69):
            a = max(0.0, 1.0 - abs(k) / 68.0) ** 2
            if a <= 0.02:
                continue
            off = k * 3.6
            draw.line(
                [(cx + off - W, cy + off - H), (cx + off + W, cy + off + H)],
                fill=(255, 255, 255, int(130 * a)),
                width=14,
            )

        # ---- 小字 ----
        text = '正在生成图片'
        if font is not None:
            box = draw.textbbox((0, 0), text, font=font)
            tw, th = box[2] - box[0], box[3] - box[1]
            x, y = (W - tw) // 2 - box[0], (H - th) // 2 - box[1]
            # 先描一层半透明阴影，浅色背景上也读得清
            draw.text((x + 1, y + 1), text, font=font, fill=(0, 0, 0, 90))
            draw.text((x, y), text, font=font, fill=(255, 255, 255, 240))

        frames.append(img)
    return frames


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    frames = build_frames()

    frames[0].save(GIF_PATH, save_all=True, append_images=frames[1:],
                   duration=DUR_MS, loop=0, optimize=True, disposal=2)
    print('GIF :', GIF_PATH, os.path.getsize(GIF_PATH), '字节')

    try:
        frames[0].save(WEBP_PATH, save_all=True, append_images=frames[1:],
                       duration=DUR_MS, loop=0, quality=82, method=4)
        print('WebP:', WEBP_PATH, os.path.getsize(WEBP_PATH), '字节')
    except Exception as exc:      # 老版本 Pillow 可能不支持动图 webp
        print('WebP 生成失败（可忽略）：', exc)


if __name__ == '__main__':
    main()
