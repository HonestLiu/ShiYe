FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pil chromium chromium-sandbox ca-certificates \
    fontconfig fonts-noto-cjk fonts-noto-color-emoji fonts-liberation \
    pandoc texlive-xetex texlive-latex-extra texlive-fonts-recommended lmodern \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 exporter \
    && useradd --uid 10001 --gid 10001 --create-home exporter \
    && mkdir -p /app /data && chown exporter:exporter /app /data

RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY local-pdf-server/package.json local-pdf-server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY local-pdf-server/*.py local-pdf-server/*.mjs local-pdf-server/*.tex ./
COPY local-pdf-server/local.html local-pdf-server/local.js local-pdf-server/local.css ./

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LOCAL_EXPORT_HOST=0.0.0.0 \
    LOCAL_EXPORT_PORT=8765 \
    LOCAL_EXPORT_DATA_DIR=/data \
    LOCAL_EXPORT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
    LOCAL_EXPORT_PLAYWRIGHT_MODULE=/app/node_modules/playwright-core
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["python3", "healthcheck.py"]
CMD ["python3", "server.py"]
