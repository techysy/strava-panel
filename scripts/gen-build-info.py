#!/usr/bin/env python3
"""生成 build.json 到仓库根目录 (打包/构建时调用)。

字段: version / commit / branch / builtAt / channel / dirty
- version  单一来源 server/VERSION
- commit/branch  取 git rev-parse; 非 git 环境容忍, 值为 "unknown"
- dirty    git status --porcelain 非空则 true; git 不可用时 false
- builtAt  ISO8601 UTC, Z 后缀
- channel  --channel 参数 (默认 "local"), 如 release/npm/docker/fpk/desktop

server/app.py 启动后按需读取根目录 build.json, 经 /api/status 的 "build" 字段透出;
文件缺失或非法时该字段为 null (开发树上常见, 属正常情况)。
"""

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _git(*args):
    """运行 git 子命令, 失败(无 git/非仓库)返回 None."""
    try:
        r = subprocess.run(
            ["git", *args],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode != 0:
            return None
        return r.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None


def main():
    ap = argparse.ArgumentParser(description="生成仓库根目录 build.json")
    ap.add_argument("--channel", default="local", help="发布渠道 (默认 local)")
    args = ap.parse_args()

    version = (ROOT / "server" / "VERSION").read_text(encoding="utf-8").strip()

    commit = _git("rev-parse", "--short", "HEAD") or "unknown"
    branch = _git("rev-parse", "--abbrev-ref", "HEAD") or "unknown"
    porcelain = _git("status", "--porcelain")
    dirty = bool(porcelain) if porcelain is not None else False

    info = {
        "version": version,
        "commit": commit,
        "branch": branch,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "channel": args.channel,
        "dirty": dirty,
    }

    out = ROOT / "build.json"
    out.write_text(
        json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("written %s: %s" % (out, json.dumps(info, ensure_ascii=False)))


if __name__ == "__main__":
    main()
