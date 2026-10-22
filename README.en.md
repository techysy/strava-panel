# Strava Panel

Strava cycling data panel — credential management, auto token refresh, riding stats visualization, AI training coach.

[![GitHub release](https://img.shields.io/github/v/release/techysy/strava-panel?label=Latest&color=blue)](https://github.com/techysy/strava-panel/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/techysy/strava-panel/blob/main/LICENSE)
[![Platform](https://img.shields.io/badge/Platform-fnOS%20%7C%20Docker%20%7C%20Windows%20%7C%20macOS%20%7C%20Linux-orange.svg)](#-quick-install)
[![Strava API](https://img.shields.io/badge/API-Strava-orange.svg)](https://developers.strava.com/)

> One zero-dependency Node.js backend (ESM, Node ≥22.13, node:sqlite), deployed everywhere — fnOS / Docker / desktop tray / npm CLI.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/home-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/home-light.png">
    <img alt="Strava Panel home (Ride Data)" src="docs/screenshots/home-light.png" width="900">
  </picture>
  <br>
  <sub>Ride Data home · stat cards switch the chart · period-over-period deltas · compare-last-period dashed line · auto light/dark</sub>
</p>

- [中文 README](./README.md)

---

## ✨ Features

- 🧭 **Tabbed panel** — Ride Data (home) / Recent Rides / Coach / FIT Tools / Trip Planner / Dashboard / Settings; auto light/dark, CN/EN UI, official Strava logomark + linear SVG icons
- 📊 **Stat cards drive the chart** — click Distance / Rides / Duration / Elevation to switch the trend metric; each card shows a period-over-period delta badge
- 📈 **Compare last period** — overlay the previous period as a dashed line; tooltip shows this/last/% change; day view uses weekday labels + an orange "today" marker (matches official Strava)
- ❤️ **Heart rate / power** — captures avg/max HR, avg power, kJ; per-ride columns plus auto-hiding mean cards
- ✂️ **FIT Tools (100% Client-Side, Zero Upload)**:
  - **Visual crop with "Crop-then-Merge" workflow**: Drag S/E markers on map to crop, switch files with floating bottom-right glass list in fullscreen; auto-drafts memory; combine multiple cropped tracks seamlessly.
  - **Smart moving time detection**: Accurately filters out red lights, long pauses, and cross-file merge gaps. Adaptive display of "Elapsed xx · Moving xx" and real moving time written to generated FIT Session/Lap messages.
  - **Combine / Split / Strip**: Merge multi-segment files with automatic timestamp continuity; split by time gaps or record counts; strip private power/heart-rate fields; export to GPX / TCX.
- 🏔️ **Outdoor Trip Planner (GPX + Hourly Weather + Trains)**:
  - Search any global destination (Open-Meteo geocoding); hourly temperature and wind charts.
  - Load GPX route files, calculate ETA timeline and elevation profile by constant speed.
  - High-speed train ticket lookup with departure time filters and duration sorting.
- 🤖 **AI training coach** — plug in any OpenAI-compatible API (Ollama / LM Studio / vLLM / One-API local gateways); it injects your training digest (7/28/90-day + weekly trend + last 15 rides) for actionable plans. **Multi-session** context control, **gateway model list** grouped by provider, per-session model override, conversation memory in local SQLite
- 🔄 **Incremental / full sync** — daily incremental is seconds (watermark `after=`), full resync backfills historical fields
- 📜 **Log console** — System / Strava API / Agent segmented switch, archived by date
- 🔑 **Credentials** — Client ID / Secret in-panel (secret masked + reveal), Refresh Token via OAuth, auto-refreshed on 6h expiry
- 🗄️ **Three service-status groups** — Strava API / local DB / agent calls, with breathing status dots
- 📤 **Agent API** — local agents query over HTTP; copy the REST doc in-panel
- 🔒 **Zero deps** — pure Node.js stdlib (http + node:sqlite, Node ≥22.13)

## 🚀 Quick Install

One zero-dependency backend, all channels — prebuilt artifacts are on [Releases](https://github.com/techysy/strava-panel/releases):

| Channel | Artifact / command | Notes |
|---------|--------------------|-------|
| fnOS fpk | `strava-x.x.x.fpk` (web variant, opens in new tab), `strava-x.x.x-iframe.fpk` (window variant, fnOS desktop window) | fnOS App Center → Manual Install |
| Docker | `ghcr.io/techysy/strava-panel:latest` (amd64 / arm64) | `docker run -d -p 20227:20227 -v strava-data:/data ghcr.io/techysy/strava-panel:latest` |
| Windows | `StravaPanel Setup x.x.x.exe` (NSIS) / `StravaPanel x.x.x.exe` (Portable) | in-app auto-update (NSIS) |
| macOS | `StravaPanel-x.x.x-arm64.dmg` / `StravaPanel-x.x.x-x64.dmg` (zip too) | auto-update; unsigned — right-click to open first time |
| npm CLI | `npm i -g @techysy/strava-panel` (`sp` command) | system Node.js ≥22.13 |

**fnOS install steps**:

1. Download the fpk variant (web or window) from the table above
2. fnOS **App Center → Manual Install** → select the fpk (runtime depends on the App Center **nodejs_v24** app — handled automatically on install)
3. Open Strava Panel (port `20227`)
4. Fill in Strava credentials in the panel → Save & verify

### Get Strava Credentials

1. Visit [Strava My API Application](https://www.strava.com/settings/api) for **Client ID** and **Client Secret**
2. Authorize to get a **Refresh Token** (must check `activity:read_all`):

```
https://www.strava.com/oauth/authorize?client_id={YOUR_CLIENT_ID}&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=read,activity:read_all
```

3. Copy the `code=` value and exchange it at [Strava token](https://www.strava.com/oauth/token) for a refresh_token

## 📖 Usage

### Port & Data

| Item | Value |
|------|-------|
| Panel port | `20227` (high port, reduces scanning risk) |
| Credentials | `/vol4/@appdata/strava/strava.conf` (mode 600) |
| Token cache | `/vol4/@appdata/strava/strava_tokens.json` |
| SQLite cache | `/vol4/@appdata/strava/strava.db` |

### HTTP API (local agent query)

The app exposes a REST API for local agents or tools (`http://localhost:20227`).

> 🔐 **API token required since v1.2.0**: data endpoints need `Authorization: Bearer <token>`. Get the token via the auth-free `/api/bootstrap`:

```bash
# 1. Get API token (auth-free)
TOKEN=$(curl -s http://localhost:20227/api/bootstrap | jq -r '.api_token')

# 2. Access data endpoints with the token
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:20227/api/stats
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:20227/api/stats?start=2026-07-01&end=2026-07-31"   # monthly
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:20227/api/activities?type=Ride&limit=10"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:20227/api/weekly
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:20227/api/sync
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:20227/api/export?fmt=json"
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:20227/api/export?fmt=csv" -o strava.csv
```

> 💡 Agent usage: `curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:20227/api/stats?start=2026-07-01&end=2026-07-31" | jq '.total_distance_km'`

> ⚠️ Requests without a token return **401**. The frontend handles tokens automatically. Token lives in `strava.conf` (mode 600); to reset, delete that line and restart.

## 🐛 Troubleshooting

Common issues and detailed fixes: see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## 🛠️ Build from Source

```bash
# On a Linux box with fnpack installed, from the repo root
bash scripts/build.sh                  # web variant (url) → strava-<ver>.fpk
bash scripts/build.sh --variant iframe # window variant → strava-<ver>-iframe.fpk
# CI: push tag v* or trigger .github/workflows/build-fpk.yml —
# builds the web + window fpk pair + SHA256SUMS-fpk.txt onto the GitHub Release
```

## 📚 Related

- [9Router](https://github.com/techysy/9router-fnos) · [MetaCubeXD](https://github.com/techysy/metacubexd-fnos) · [Hermes WebUI](https://github.com/techysy/hermes-webui-fnos) — more fnOS apps
- [fnOS Developer Docs](https://developer.fnnas.com/docs/guide)

## License

MIT
