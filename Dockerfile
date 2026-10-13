# Strava Panel — 全平台 Docker 镜像
# 零依赖纯 Node.js (ESM, node:sqlite),镜像小:node:24-alpine
# 构建: docker build -t techysy/strava-panel .
# 运行: docker run -d --name strava-panel -p 20227:20227 -v strava-data:/data techysy/strava-panel
FROM node:24-alpine

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
    SP_DATA_DIR=/data

USER strava
EXPOSE 20227
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:20227/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/app.js"]
