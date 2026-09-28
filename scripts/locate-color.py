#!/usr/bin/env python3
"""
locate-color.py —— 按颜色定位界面元素（WebView / 小程序场景专用）

背景：微信小程序是 WebView 渲染，uiautomator 读不到控件（dump 出来只有几百字节）。
      这时唯一可靠的定位手段是「截屏 + 图像分析」。

本工具找出截图中指定颜色的连通区域，输出中心坐标 —— 直接可用于 adb shell input tap。

用法：
    python locate-color.py <截图.png> [颜色] [--min-pixels N] [--json]

颜色可选：green / blue / red / orange / purple / yellow / teal / any
    any = 列出所有显著色块（按面积排序）

示例：
    python locate-color.py shot.png green
    python locate-color.py shot.png any --min-pixels 2000
"""

import sys
import json
from collections import deque

try:
    from PIL import Image
    import numpy as np
except ImportError:
    sys.exit("需要 Pillow 与 numpy：pip install Pillow numpy")

# 颜色判据：返回布尔掩码。阈值偏宽松，宁可多找也别漏。
def color_mask(a, name):
    R = a[:, :, 0].astype(np.int16)
    G = a[:, :, 1].astype(np.int16)
    B = a[:, :, 2].astype(np.int16)

    if name == "green":
        return (G > 120) & (G - R > 35) & (G - B > 35)
    if name == "blue":
        return (B > 120) & (B - R > 35) & (B - G > 25)
    if name == "red":
        return (R > 130) & (R - G > 50) & (R - B > 50)
    if name == "orange":
        return (R > 180) & (G > 100) & (G < 200) & (R - B > 80) & (R - G > 20)
    if name == "purple":
        return (R > 110) & (B > 140) & (B - G > 40) & (R - G > 20)
    if name == "yellow":
        return (R > 180) & (G > 160) & (B < 120) & (R - B > 80)
    if name == "teal":
        return (G > 130) & (B > 130) & (R < 140) & (G - R > 30)
    if name == "any":
        # 非灰（饱和度够高）就算显著色块
        mx = np.maximum(np.maximum(R, G), B)
        mn = np.minimum(np.minimum(R, G), B)
        return (mx - mn) > 60
    raise ValueError(f"未知颜色: {name}")


def find_regions(mask, min_pixels):
    """BFS 找连通区域（4 邻域）"""
    H, W = mask.shape
    visited = np.zeros((H, W), dtype=bool)
    regions = []

    # 只遍历掩码内的像素，避免全图扫描
    ys, xs = np.where(mask)
    coords = set(zip(ys.tolist(), xs.tolist()))

    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if visited[sy, sx]:
            continue
        q = deque([(sy, sx)])
        visited[sy, sx] = True
        cnt = 0
        miny = maxy = sy
        minx = maxx = sx
        while q:
            cy, cx = q.popleft()
            cnt += 1
            if cy < miny: miny = cy
            if cy > maxy: maxy = cy
            if cx < minx: minx = cx
            if cx > maxx: maxx = cx
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < H and 0 <= nx < W and not visited[ny, nx] and (ny, nx) in coords:
                    visited[ny, nx] = True
                    q.append((ny, nx))
        if cnt >= min_pixels:
            regions.append({
                "pixels": cnt,
                "bbox": [minx, miny, maxx, maxy],
                "center": [(minx + maxx) // 2, (miny + maxy) // 2],
                "size": [maxx - minx + 1, maxy - miny + 1],
            })

    regions.sort(key=lambda r: -r["pixels"])
    return regions


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    path = sys.argv[1]
    color = "any"
    min_pixels = 800
    as_json = False

    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--min-pixels":
            min_pixels = int(args[i + 1]); i += 2
        elif args[i] == "--json":
            as_json = True; i += 1
        else:
            color = args[i]; i += 1

    img = Image.open(path).convert("RGB")
    W, H = img.size
    a = np.array(img)
    mask = color_mask(a, color)
    regions = find_regions(mask, min_pixels)

    if as_json:
        print(json.dumps({
            "image": path, "size": [W, H], "color": color,
            "regions": regions
        }, ensure_ascii=False, indent=2))
        return

    print(f"图片: {path}  尺寸: {W}x{H}  颜色: {color}  最小像素: {min_pixels}")
    print(f"命中区域: {len(regions)} 个")
    print("-" * 68)
    for idx, r in enumerate(regions):
        cx, cy = r["center"]
        x1, y1, x2, y2 = r["bbox"]
        print(f"[{idx}] 中心=({cx:4d}, {cy:4d})  尺寸={r['size'][0]}x{r['size'][1]}  "
              f"像素={r['pixels']:6d}  bbox=({x1},{y1})-({x2},{y2})")


if __name__ == "__main__":
    main()
