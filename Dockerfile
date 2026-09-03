# Strava Panel — 全平台 Docker 镜像
# 零依赖纯标准库服务,镜像极小:python:3.12-alpine ≈ 60MB
# 构建: docker build -t techysy/strava-panel .
# 运行: docker run -d --name strava-panel -p 20227:20227 -v strava-data:/data techysy/strava-panel
FROM python:3.12-alpine

LABEL org.opencontainers.image.title="Strava Panel"
LABEL org.opencontainers.image.description="Strava 骑行数据面板 — 凭据管理、Token 自动刷新、骑行统计可视化、Agent API"
LABEL org.opencontainers.image.source="https://github.com/techysy/strava-panel"
LABEL org.opencontainers.image.licenses="MIT"

# 非 root 运行
RUN addgroup -S strava && adduser -S strava -G strava \
    && mkdir -p /data && chown strava:strava /data

WORKDIR /app
COPY server/ ./server/
COPY www/ ./www/

ENV SP_PORT=20227 \
    SP_HOST=0.0.0.0 \
    SP_DATA_DIR=/data \
    PYTHONUNBUFFERED=1

USER strava
EXPOSE 20227
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:20227/api/status',timeout=4)" || exit 1

CMD ["python", "-u", "server/app.py"]
