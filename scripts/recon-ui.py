#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
安卓界面侦察工具（只读）

用途：在不安装任何 App 的前提下，dump 当前屏幕的控件树，
      判断目标界面（如乐跑的里程数字）能否被无障碍/自动化读取。

为什么需要它：
  自动化方案的第一分支点 —— 里程数字是"控件文本"还是"WebView 里的画布"。
  前者可以直接 text() 读取，后者必须退到 OCR。这一步决定整个监控层的实现。

用法：
  python recon-ui.py                 # 抓一次，输出结构化报告
  python recon-ui.py --watch 5       # 每 5 秒抓一次，追踪文本变化（观察里程增长）
  python recon-ui.py --watch 5 -n 30 # 最多抓 30 次
  python recon-ui.py --save a.xml    # 保存原始 XML 到本地
  python recon-ui.py --raw           # 直接打印原始 XML

环境变量 ADB 可覆盖 adb 路径。
"""

import argparse
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ADB = os.environ.get(
    "ADB",
    r"D:\Android\toolchain\sdk\platform-tools\adb.exe",
)
REMOTE = "/sdcard/_recon_ui.xml"

NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")


def sh(args, timeout=30):
    """执行 adb 命令，返回 stdout。"""
    try:
        r = subprocess.run(
            [ADB] + args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError:
        sys.exit(f"[x] 找不到 adb：{ADB}\n    用环境变量 ADB 指定正确路径。")
    except subprocess.TimeoutExpired:
        return ""
    return r.stdout or ""


def check_device():
    out = sh(["devices"])
    lines = [l for l in out.splitlines()[1:] if l.strip()]
    if not lines:
        sys.exit("[x] 没有设备连接。检查 USB 调试 / 授权弹窗。")
    if any("unauthorized" in l for l in lines):
        sys.exit("[x] 设备未授权。请在手机上点『允许 USB 调试』。")
    return lines[0].split()[0]


def dump_xml():
    """抓取当前界面 XML。返回 (xml_text, 顶层包名)。"""
    out = sh(["shell", "uiautomator", "dump", REMOTE])
    if "dumped" not in out.lower() and "dumped" not in out.lower():
        # 部分 ROM 输出到 stderr，重试一次
        pass
    xml_text = sh(["shell", "cat", REMOTE])
    if not xml_text.strip().startswith("<?xml"):
        return None, None
    return xml_text, None


def parse(xml_text):
    """解析成节点列表。"""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        print(f"[!] XML 解析失败：{e}")
        return []
    nodes = []
    for n in root.iter("node"):
        a = n.attrib
        nodes.append(
            {
                "text": a.get("text", ""),
                "desc": a.get("content-desc", ""),
                "rid": a.get("resource-id", ""),
                "cls": a.get("class", ""),
                "pkg": a.get("package", ""),
                "bounds": a.get("bounds", ""),
                "clickable": a.get("clickable") == "true",
                "scrollable": a.get("scrollable") == "true",
                "checkable": a.get("checkable") == "true",
                "checked": a.get("checked") == "true",
            }
        )
    return nodes


def center(bounds):
    m = re.findall(r"\[(\d+),(\d+)\]", bounds or "")
    if len(m) != 2:
        return None
    (x1, y1), (x2, y2) = (int(m[0][0]), int(m[0][1])), (int(m[1][0]), int(m[1][1]))
    return (x1 + x2) // 2, (y1 + y2) // 2


def report(nodes, xml_text):
    if not nodes:
        print("[!] 控件树为空 —— 可能是 WebView/游戏引擎渲染，无障碍读不到内容。")
        print("    这种情况必须退到 OCR 或找图找色方案。")
        return

    pkgs = sorted({n["pkg"] for n in nodes if n["pkg"]})
    print(f"界面包名：{', '.join(pkgs) if pkgs else '(未知)'}")
    print(f"节点总数：{len(nodes)}")
    print()

    texts = [n for n in nodes if n["text"].strip()]
    print(f"───── 有文本的节点（{len(texts)} 个）─────")
    if not texts:
        print("  (无)  ← 危险信号：界面内容读不到，大概率是 WebView/Canvas 渲染")
    for n in texts:
        c = center(n["bounds"])
        loc = f"@{c[0]},{c[1]}" if c else ""
        rid = f"  id={n['rid']}" if n["rid"] else ""
        print(f"  「{n['text']}」{loc}{rid}")
    print()

    clicks = [n for n in nodes if n["clickable"]]
    print(f"───── 可点击元素（{len(clicks)} 个）─────")
    for n in clicks:
        c = center(n["bounds"])
        loc = f"@{c[0]},{c[1]}" if c else ""
        label = n["text"] or n["desc"] or n["cls"].split(".")[-1]
        rid = f"  id={n['rid']}" if n["rid"] else ""
        print(f"  [{label}]{loc}{rid}")
    print()

    nums = sorted({m.group() for n in texts for m in NUM_RE.finditer(n["text"])})
    if nums:
        print(f"───── 疑似数值（{len(nums)} 个，候选里程/时间）─────")
        print(f"  {', '.join(nums)}")
        print()


def watch(interval, count):
    print(f"每 {interval}s 抓一次，最多 {count} 次。Ctrl+C 停止。\n")
    prev = None
    for i in range(count):
        xml_text, _ = dump_xml()
        if not xml_text:
            print(f"[{i+1}] dump 失败")
            time.sleep(interval)
            continue
        nodes = parse(xml_text)
        cur = {n["text"] for n in nodes if n["text"].strip()}
        ts = time.strftime("%H:%M:%S")
        if prev is None:
            print(f"[{ts}] 初始文本 {len(cur)} 条：")
            for t in sorted(cur):
                print(f"    {t}")
        else:
            added = cur - prev
            removed = prev - cur
            if not added and not removed:
                print(f"[{ts}] 无变化")
            else:
                for t in sorted(added):
                    print(f"[{ts}] + {t}")
                for t in sorted(removed):
                    print(f"[{ts}] - {t}")
        prev = cur
        if i < count - 1:
            time.sleep(interval)
    print("\n完成。")


def main():
    ap = argparse.ArgumentParser(description="安卓界面侦察工具（只读）")
    ap.add_argument("--watch", type=int, metavar="SEC", help="持续抓取，间隔秒数")
    ap.add_argument("-n", "--count", type=int, default=9999, help="watch 模式最大次数")
    ap.add_argument("--save", metavar="FILE", help="保存原始 XML")
    ap.add_argument("--raw", action="store_true", help="打印原始 XML")
    args = ap.parse_args()

    dev = check_device()
    print(f"设备：{dev}\n")

    if args.watch:
        watch(args.watch, args.count)
        return

    xml_text, _ = dump_xml()
    if not xml_text:
        sys.exit("[x] dump 失败。确认屏幕已解锁、设备已连接。")

    if args.raw:
        print(xml_text)
    if args.save:
        with open(args.save, "w", encoding="utf-8") as f:
            f.write(xml_text)
        print(f"原始 XML 已保存：{args.save}\n")
    if not args.raw:
        report(parse(xml_text), xml_text)


if __name__ == "__main__":
    main()
