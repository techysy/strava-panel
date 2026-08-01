#!/usr/bin/env python3
"""
Strava Panel — fnOS 后端服务 (零依赖, 纯标准库)
凭据管理 + Token 自动刷新 + SQLite 本地缓存 + 骑行数据 API

数据目录结构 (TRIM_PKGVAR / 或 --data):
  strava.conf           # client_id / client_secret / refresh_token
  strava_tokens.json    # 缓存的 access_token (自动刷新)
  strava.db             # SQLite 缓存 (activities 表)

API:
  GET  /api/status        # 凭据/授权/缓存状态
  POST /api/config        # 保存凭据 (JSON)
  GET  /api/stats         # 骑行统计 (读 SQLite 缓存，快)
  GET  /api/activities    # 最近活动列表 (读缓存)
  GET  /api/weekly        # 每周聚合
  GET  /api/sync          # 手动触发 Strava→SQLite 同步
  GET  /api/export?fmt=json|csv   # 导出全量数据 (给 agent)
  GET  /                   # 前端面板
"""
import csv
import io
import json
import os
import re
import sys
import time
import secrets
import urllib.request
import urllib.parse
import threading
import http.server
import socketserver
import datetime
from pathlib import Path
from db import StravaDB

STRAVA_AUTH_URL = "https://www.strava.com/oauth/token"
STRAVA_API = "https://www.strava.com/api/v3"
API_HEADERS = {"Accept": "application/json"}

DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/strava-data"))
CONF_FILE = DATA_DIR / "strava.conf"
TOKEN_FILE = DATA_DIR / "strava_tokens.json"
DB_FILE = DATA_DIR / "strava.db"
WWW_DIR = Path(__file__).parent.parent / "www"

_lock = threading.Lock()
db = StravaDB(DB_FILE)


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
        f"api_token={cfg.get('api_token','')}",
    ]
    CONF_FILE.write_text("\n".join(lines) + "\n")
    os.chmod(CONF_FILE, 0o600)  # 权限 600，仅属主可读
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink(missing_ok=True)


def has_credentials():
    cfg = load_config()
    return bool(cfg.get("client_id") and cfg.get("client_secret") and cfg.get("refresh_token"))


# ---------- API Token 保护 ----------
def get_or_create_api_token():
    """获取/生成 API 访问 token（存 strava.conf 的 api_token 字段）"""
    cfg = load_config()
    tok = cfg.get("api_token", "").strip()
    if not tok:
        tok = secrets.token_urlsafe(32)
        cfg["api_token"] = tok
        save_config(cfg)
    return tok


def api_token_valid(token):
    """校验 API token"""
    if not token:
        return False
    cfg = load_config()
    expected = cfg.get("api_token", "")
    return token == expected


# ---------- Strava token ----------
def refresh_token(cfg):
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
    tok = {
        "access_token": r["access_token"],
        "refresh_token": r.get("refresh_token", cfg.get("refresh_token", "")),
        "scope": r.get("scope", ""),
        "expires_at": r.get("expires_at"),
    }
    TOKEN_FILE.write_text(json.dumps(tok))
    os.chmod(TOKEN_FILE, 0o600)
    if r.get("refresh_token"):
        cfg["refresh_token"] = r["refresh_token"]
        save_config(cfg)
    return r["access_token"]


def get_access_token():
    cfg = load_config()
    if not has_credentials():
        return None, "未配置凭据"
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


def get_activities_page(token, page=1, per_page=100, after=None):
    params = {"per_page": per_page, "page": page}
    if after:
        params["after"] = after
    return _api_get(token, "/athlete/activities", params)


def sync_from_strava(token, limit_pages=20):
    """全量/增量同步 Strava→SQLite。返回统计"""
    all_acts = []
    page = 1
    while page <= limit_pages:
        acts = get_activities_page(token, page=page, per_page=100)
        if not acts:
            break
        all_acts.extend(acts)
        # 增量：若已到已知的最新活动，跳过后续页（避免重复拉取全历史）
        if page == 1:
            last_sync = db.get_meta("last_sync")
            # last_sync 是时间戳，无法直接对比活动日期；简单起见全量拉取 limit_pages
        page += 1
        if page > 1 and len(acts) < 100:
            break
    added = db.upsert_activities(all_acts)
    return {"activities": len(all_acts), "new": added, "page": page - 1}


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
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, rel):
        p = (WWW_DIR / rel).resolve()
        if not str(p).startswith(str(WWW_DIR.resolve())) or not p.exists():
            self.send_error(404)
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript",
            ".css": "text/css",
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

    def _get_qs(self):
        return {k: v[0] for k, v in urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query).items()}

    def _require_token(self):
        tok, err = get_access_token()
        if not tok:
            self._send_json({"error": err or "未配置"}, 400)
            return None, err
        return tok, None

    def _require_api_token(self):
        """校验 API 访问 token（数据接口保护）。返回是否通过。"""
        # 从 Authorization header 或 ?token= 参数读取
        token = None
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        if not token:
            token = self._get_qs().get("token")
        if not api_token_valid(token):
            self._send_json({"error": "无效的 API token，请使用 Authorization: Bearer <token>"}, 401)
            return False
        return True

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        qs = self._get_qs()
        if path == "/api/bootstrap":
            # 免认证：返回 API token，供面板前端初始加载使用
            self._send_json({"api_token": get_or_create_api_token(), "configured": has_credentials()})
        elif path == "/api/status":
            cfg = load_config()
            tok, err = get_access_token()
            self._send_json({
                "configured": has_credentials(),
                "has_token": bool(tok),
                "token_error": err,
                "athlete_id": cfg.get("athlete_id"),
                "db_activities": db.count(),
                "last_sync": db.get_meta("last_sync"),
            })
        elif path == "/api/stats":
            if not self._require_api_token():
                return
            tok, err = self._require_token()
            if not tok:
                return
            try:
                # 确保缓存有数据
                if db.count() == 0:
                    sync_from_strava(tok)
                stats = db.stats(start_date=qs.get("start"), end_date=qs.get("end"))
                stats["weekly"] = db.weekly(start_date=qs.get("start"), end_date=qs.get("end"))
                stats["last_sync"] = db.get_meta("last_sync")
                self._send_json(stats)
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/weekly":
            if not self._require_api_token():
                return
            tok, err = self._require_token()
            if not tok:
                return
            try:
                if db.count() == 0:
                    sync_from_strava(tok)
                self._send_json({"weekly": db.weekly(start_date=qs.get("start"), end_date=qs.get("end"))})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/activities":
            if not self._require_api_token():
                return
            tok, err = self._require_token()
            if not tok:
                return
            try:
                if db.count() == 0:
                    sync_from_strava(tok)
                acts = db.get_activities(
                    type_filter=qs.get("type"),
                    limit=int(qs.get("limit", 50)),
                    start_date=qs.get("start"),
                    end_date=qs.get("end"))
                self._send_json({"activities": acts, "count": len(acts)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/sync":
            if not self._require_api_token():
                return
            tok, err = self._require_token()
            if not tok:
                return
            try:
                with _lock:
                    result = sync_from_strava(tok)
                self._send_json({"ok": True, **result})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/export":
            if not self._require_api_token():
                return
            tok, err = self._require_token()
            if not tok:
                return
            try:
                if db.count() == 0:
                    sync_from_strava(tok)
                acts = db.get_activities(limit=100000)
                fmt = qs.get("fmt", "json")
                if fmt == "csv":
                    out = io.StringIO()
                    w = csv.writer(out)
                    w.writerow(["id","name","type","distance_km","moving_time_s","elevation_m","start_date"])
                    for a in acts:
                        w.writerow([a["id"], a["name"], a["type"],
                                    round((a.get("distance") or 0)/1000, 2),
                                    a.get("moving_time"), a.get("total_elevation_gain"),
                                    a.get("start_date")])
                    body = out.getvalue().encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", 'attachment; filename="strava.csv"')
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self._send_json({"activities": acts, "count": len(acts)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/config":
            if not self._require_api_token():
                return
            cfg = load_config()
            # 不返回敏感字段（client_secret/refresh_token/api_token）
            self._send_json({
                "client_id": cfg.get("client_id", ""),
                "configured": has_credentials(),
            })
        elif path == "/" or path == "":
            self._send_file("index.html")
        elif path.startswith("/static/"):
            self._send_file(path[len("/static/"):])
        else:
            self.send_error(404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            if not self._require_api_token():
                return
            try:
                data = json.loads(self._read_body())
                with _lock:
                    cfg = load_config()
                    for k in ("client_id", "client_secret", "refresh_token"):
                        if data.get(k):
                            cfg[k] = str(data[k]).strip()
                    save_config(cfg)
                tok, err = get_access_token()
                # 验证通过后自动同步一次
                if tok:
                    try:
                        sync_from_strava(tok)
                    except Exception:
                        pass
                self._send_json({"ok": bool(tok), "error": err, "token_ok": bool(tok)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        elif path == "/api/sync":
            if not self._require_api_token():
                return
            tok, err = get_access_token()
            if not tok:
                self._send_json({"error": err or "未配置"}, 400); return
            try:
                with _lock:
                    result = sync_from_strava(tok)
                self._send_json({"ok": True, **result})
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
    port = int(os.environ.get("PORT", "20127"))
    # SO_REUSEADDR：避免频繁重启后 TIME_WAIT 导致 "Address already in use"
    # 必须在实例化前设置类属性（socketserver 在 __init__ 时 bind）
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True
    print(f"Strava Panel listening on {port}", flush=True)
    print(f"Data dir: {DATA_DIR}", flush=True)
    print(f"DB: {DB_FILE}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
