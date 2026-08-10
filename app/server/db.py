#!/usr/bin/env python3
"""Strava SQLite 缓存层 — 本地存储 + 查询"""
import json
import sqlite3
import datetime
from pathlib import Path


class StravaDB:
    def __init__(self, db_path):
        self.db_path = Path(db_path)
        self._init()

    def _conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        # 确保 schema 存在（幂等；兼容 db 文件被删/重建）
        conn.execute("""CREATE TABLE IF NOT EXISTS activities(
            id INTEGER PRIMARY KEY,
            name TEXT,
            type TEXT,
            distance REAL,
            moving_time REAL,
            total_elevation_gain REAL,
            start_date TEXT,
            start_date_local TEXT,
            elapsed_time REAL,
            average_speed REAL,
            max_speed REAL
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS meta(
            key TEXT PRIMARY KEY,
            value TEXT
        )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_start_date ON activities(start_date)")
        return conn

    def _init(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS activities(
                id INTEGER PRIMARY KEY,
                name TEXT,
                type TEXT,
                distance REAL,
                moving_time REAL,
                total_elevation_gain REAL,
                start_date TEXT,
                start_date_local TEXT,
                elapsed_time REAL,
                average_speed REAL,
                max_speed REAL
            )""")
            c.execute("""CREATE TABLE IF NOT EXISTS meta(
                key TEXT PRIMARY KEY,
                value TEXT
            )""")
            c.execute("CREATE INDEX IF NOT EXISTS idx_start_date ON activities(start_date)")

    # ---- write ----
    def upsert_activities(self, activities):
        """批量写入活动（upsert by id），返回新增数"""
        added = 0
        with self._conn() as c:
            for a in activities:
                rid = a.get("id")
                if not rid:
                    continue
                cur = c.execute("SELECT id FROM activities WHERE id=?", (rid,))
                if cur.fetchone() is None:
                    added += 1
                c.execute("""INSERT OR REPLACE INTO activities
                    (id,name,type,distance,moving_time,total_elevation_gain,
                     start_date,start_date_local,elapsed_time,average_speed,max_speed)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                    (rid, a.get("name"), a.get("type"), a.get("distance"),
                     a.get("moving_time"), a.get("total_elevation_gain"),
                     a.get("start_date"), a.get("start_date_local"),
                     a.get("elapsed_time"), a.get("average_speed"), a.get("max_speed")))
        self.set_meta("last_sync", datetime.datetime.now().isoformat())
        return added

    def set_meta(self, key, value):
        with self._conn() as c:
            c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, str(value)))

    def get_meta(self, key, default=None):
        with self._conn() as c:
            r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return r["value"] if r else default

    # ---- query ----
    def get_activities(self, type_filter=None, limit=200, start_date=None, end_date=None):
        q = "SELECT * FROM activities WHERE 1=1"
        params = []
        if type_filter:
            q += " AND type=?"
            params.append(type_filter)
        if start_date:
            q += " AND start_date >= ?"
            params.append(start_date)
        if end_date:
            q += " AND start_date <= ?"
            params.append(end_date + "T23:59:59")
        q += " ORDER BY start_date DESC LIMIT ?"
        params.append(limit)
        with self._conn() as c:
            return [dict(r) for r in c.execute(q, params).fetchall()]

    def get_rides(self, start_date=None, end_date=None, limit=100000):
        return self.get_activities(type_filter="Ride", start_date=start_date,
                                   end_date=end_date, limit=limit)

    def count(self):
        with self._conn() as c:
            r = c.execute("SELECT COUNT(*) n, COUNT(DISTINCT id) d FROM activities").fetchone()
            return r["n"]

    def stats(self, start_date=None, end_date=None):
        """统计骑行数据，支持日期范围过滤"""
        q = """SELECT COUNT(*) total_rides,
                      SUM(distance) total_distance,
                      SUM(moving_time) total_moving_time,
                      SUM(total_elevation_gain) total_elevation
               FROM activities WHERE type='Ride'"""
        params = []
        if start_date:
            q += " AND start_date >= ?"; params.append(start_date)
        if end_date:
            q += " AND start_date <= ?"; params.append(end_date + "T23:59:59")
        with self._conn() as c:
            r = c.execute(q, params).fetchone()
        n = r["total_rides"] or 0
        dist = (r["total_distance"] or 0) / 1000
        dur = (r["total_moving_time"] or 0) / 3600
        elev = r["total_elevation"] or 0
        return {
            "total_rides": n,
            "total_distance_km": round(dist, 1),
            "total_duration_h": round(dur, 1),
            "total_elevation_m": round(elev, 0),
            "avg_distance_km": round(dist / n, 1) if n else 0,
        }

    def weekly(self, start_date=None, end_date=None):
        """按 ISO 周聚合"""
        rows = self.get_rides(start_date=start_date, end_date=end_date, limit=100000)
        weeks = {}
        for a in rows:
            d = (a.get("start_date") or "")[:10]
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
        return [{"week": k, **v} for k, v in sorted(weeks.items())]

    def monthly(self, start_date=None, end_date=None):
        """按月份聚合（返回月度汇总）"""
        rows = self.get_rides(start_date=start_date, end_date=end_date, limit=100000)
        months = {}
        for a in rows:
            d = (a.get("start_date") or "")[:10]
            try:
                dt = datetime.date.fromisoformat(d)
            except Exception:
                continue
            key = f"{dt.year}-{dt.month:02d}"
            m = months.setdefault(key, {"count": 0, "dist_km": 0.0, "duration_h": 0.0, "elev_m": 0.0})
            m["count"] += 1
            m["dist_km"] += (a.get("distance") or 0) / 1000
            m["duration_h"] += (a.get("moving_time") or 0) / 3600
            m["elev_m"] += (a.get("total_elevation_gain") or 0)
        return [{"month": k, **v} for k, v in sorted(months.items())]
