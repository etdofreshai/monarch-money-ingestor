FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    openbox \
    supervisor \
    ca-certificates \
    ttf-liberation \
  && mkdir -p /data/chrome-profile /var/log/supervisor

COPY package*.json ./
COPY scripts/ ./scripts/
ARG CACHEBUST=1
RUN npm install && chmod +x scripts/start-chrome.sh

COPY tsconfig.json ./
COPY src/ ./src/
COPY supervisord.conf ./supervisord.conf
RUN npm run build

ENV BROWSER_PROFILE_DIR=/data/chrome-profile \
    BROWSER_START_URL=https://app.monarchmoney.com/login \
    CHROME_CDP_URL=http://127.0.0.1:9222 \
    CHROME_REMOTE_DEBUGGING_PORT=9222 \
    DISPLAY=:99

VOLUME /data

CMD ["supervisord", "-c", "/app/supervisord.conf"]
