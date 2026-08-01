#!/usr/bin/env python3
"""
Strava Panel — fnOS 后端服务 (零依赖, 纯标准库)
凭据管理 + Token 自动刷新 + 骑行数据 API

数据目录结构 (TRIM_PKGVAR / 或运行时 --data):
  strava.conf      # client_id / client_secret / refresh_token / athlete_id
  strava_tokens.json  # 缓存的 access_token (自动刷新)

API:
  GET /api/status        # 凭据/授权状态
  POST /api/config       # 保存凭据 (JSON)
  GET /api/activities    # 最近活动列表
  GET /api/stats         # 骑行统计 (总次数/距离/时长/爬升 + 按周)
  GET /                 # 前端面板 (www/)
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import threading
import http.server
import socketserver
import datetime
from pathlib import Path

STRAVA_AUTH_URL = "https://www.strava.com/oauth/token"
STRAVA_API = "https://www.strava.com/api/v3"
API_HEADERS = {"Accept": "application/json"}

DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/strava-data"))
CONF_FILE = DATA_DIR / "strava.conf"
TOKEN_FILE = DATA_DIR / "strava_tokens.json"
WWW_DIR = Path(__file__).parent.parent / "www"

_lock = threading.Lock()


# ---------- 配置 ----------
def load_config():
    cfg = {}
    if CONF_FILE.exists():
        for line in CONF_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    return cfg


def save_config(cfg):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    lines = [
        f"client_id={cfg.get('client_id','')}",
        f"client_secret={cfg.get('client_secret','')}",
        f"refresh_token={cfg.get('refresh_token','')}",
        f"athlete_id={cfg.get('athlete_id','')}",
    ]
    CONF_FILE.write_text("\n".join(lines) + "\n")
    # 有变化时清 token 缓存
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink(missing_ok=True)


def has_credentials():
    cfg = load_config()
    return bool(cfg.get("client_id") and cfg.get("client_secret") and cfg.get("refresh_token"))


# ---------- Strava token ----------
def refresh_token(cfg):
    """用 refresh_token 换新 access_token"""
    data = urllib.parse.urlencode({
        "client_id": cfg.get("client_id", ""),
        "client_secret": cfg.get("client_secret", ""),
        "grant_type": "refresh_token",
        "refresh_token": cfg.get("refresh_token", ""),
    }).encode()
    req = urllib.request.Request(STRAVA_AUTH_URL, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        r = json.loads(resp.read().decode())
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps({
        "access_token": r["access_token"],
        "refresh_token": r.get("refresh_token", cfg.get("refresh_token", "")),
        "scope": r.get("scope", ""),
        "expires_at": r.get("expires_at"),
    }))
    # 更新 refresh_token 到 conf (Strava 轮换)
    if r.get("refresh_token"):
        cfg["refresh_token"] = r["refresh_token"]
        save_config(cfg)
    return r["access_token"]


def get_access_token():
    """获取可用 access_token，必要时刷新"""
    cfg = load_config()
    if not has_credentials():
        return None, "未配置凭据"
    # 有缓存且未过期则用缓存
    if TOKEN_FILE.exists():
        try:
            tok = json.loads(TOKEN_FILE.read_text())
            exp = tok.get("expires_at")
            if exp and exp > int(time.time()) + 300 and tok.get("access_token"):
                return tok["access_token"], None
        except Exception:
            pass
    try:
        return refresh_token(cfg), None
    except Exception as e:
        return None, f"刷新失败: {e}"


# ---------- Strava API ----------
def _api_get(token, path, params=None):
    url = f"{STRAVA_API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={**API_HEADERS, "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def get_activities(token, per_page=100, before=None, after=None):
    params = {"per_page": per_page}
    if before: params["before"] = before
    if after: params["after"] = after
    return _api_get(token, "/athlete/activities", params)


# ---------- 统计 ----------
def compute_stats(activities):
    """统计骑行数据 (只算 Ride, 排除 EBikeRide/Walk 等)"""
    rides = [a for a in activities if a.get("type") == "Ride"]
    total = len(rides)
    dist_km = sum((a.get("distance") or 0) for a in rides) / 1000
    dur_h = sum((a.get("moving_time") or 0) for a in rides) / 3600
    elev_m = sum((a.get("total_elevation_gain") or 0) for a in rides)

    # 按周聚合
    weeks = {}
    for a in rides:
        d = a.get("start_date", "")[:10]
        try:
            dt = datetime.date.fromisoformat(d)
        except Exception:
            continue
        wk = dt.isocalendar()[1]
        key = f"{dt.year}-W{wk:02d}"
        w = weeks.setdefault(key, {"count": 0, "dist_km": 0.0, "duration_h": 0.0, "elev_m": 0.0})
        w["count"] += 1
        w["dist_km"] += (a.get("distance") or 0) / 1000
        w["duration_h"] += (a.get("moving_time") or 0) / 3600
        w["elev_m"] += (a.get("total_elevation_gain") or 0)

    return {
        "total_rides": total,
        "total_distance_km": round(dist_km, 1),
        "total_duration_h": round(dur_h, 1),
        "total_elevation_m": round(elev_m, 0),
        "avg_distance_km": round(dist_km / total, 1) if total else 0,
        "weekly": [{"week": k, **v} for k, v in sorted(weeks.items())],
    }


# ---------- HTTP server ----------
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, rel):
        # 防目录穿越
        p = (WWW_DIR / rel).resolve()
        if not str(p).startswith(str(WWW_DIR.resolve())) or not p.exists():
            self.send_error(404)
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
        }.get(p.suffix, "application/octet-stream")
        body = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length).decode() if length else ""

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/status":
            cfg = load_config()
            tok, err = get_access_token()
            self._send_json({
                "configured": has_credentials(),
                "has_token": bool(tok),
                "token_error": err,
                "athlete_id": cfg.get("athlete_id"),
            })
        elif path == "/api/activities":
            tok, err = get_access_token()
            if not tok:
                self._send_json({"error": err or "未配置"}, 400); return
            try:
                acts = get_activities(tok, per_page=100)
                self._send_json({"activities": acts})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/stats":
            tok, err = get_access_token()
            if not tok:
                self._send_json({"error": err or "未配置"}, 400); return
            try:
                acts = get_activities(tok, per_page=200)
                self._send_json(compute_stats(acts))
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/config":
            self._send_json(load_config())
        elif path == "/" or path == "":
            self._send_file("index.html")
        elif path.startswith("/static/"):
            self._send_file(path[len("/static/"):])
        else:
            self.send_error(404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            try:
                data = json.loads(self._read_body())
                with _lock:
                    cfg = load_config()
                    for k in ("client_id", "client_secret", "refresh_token"):
                        if data.get(k):
                            cfg[k] = str(data[k]).strip()
                    save_config(cfg)
                # 立即验证
                tok, err = get_access_token()
                self._send_json({"ok": bool(tok), "error": err, "token_ok": bool(tok)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def main():
    port = int(os.environ.get("PORT", "8080"))
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True
    print(f"Strava Panel listening on {port}", flush=True)
    print(f"Data dir: {DATA_DIR}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
