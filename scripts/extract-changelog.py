#!/usr/bin/env python3
"""从 CHANGELOG.md 提取指定版本的段落(供 CI Release Notes 用)。

用法: python3 scripts/extract-changelog.py <version> [changelog_path]
  version 如 2.2.0(不带 v 前缀)
输出: 该版本段落正文(不含 `## vX.Y.Z` 标题行),未找到输出空串。
"""
import re
import sys


def extract(version: str, path: str = "CHANGELOG.md") -> str:
    text = open(path, encoding="utf-8").read()
    # 匹配 `## v2.2.0 (2026-10-15)` / `## 2.2.0` / `## [2.2.0]` 开头的段落,到下一个 `## ` 或文末
    m = re.search(
        r"^## \[?v?" + re.escape(version) + r"\]?[^\n]*\n(.*?)(?=^## |\Z)",
        text,
        re.M | re.S,
    )
    return m.group(1).strip() if m else ""


if __name__ == "__main__":
    ver = sys.argv[1] if len(sys.argv) > 1 else ""
    path = sys.argv[2] if len(sys.argv) > 2 else "CHANGELOG.md"
    out = extract(ver, path)
    # Windows 控制台默认 GBK,emoji 会崩;强制 UTF-8 输出
    sys.stdout.buffer.write(out.encode("utf-8"))
