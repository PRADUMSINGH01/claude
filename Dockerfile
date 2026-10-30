# Motion Studio harness: Node + FFmpeg + HyperFrames' pinned headless Chrome + the skills.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates ffmpeg fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
      libnss3 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libpango-1.0-0 libcairo2 \
      python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/harness
COPY harness/package.json harness/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Download the pinned Chrome once into a shared, read-only location.
ENV HOME=/opt/hf-home
RUN mkdir -p /opt/hf-home \
 && HYPERFRAMES_NO_TELEMETRY=1 ./node_modules/.bin/hyperframes browser ensure \
 && ln -s "$(HYPERFRAMES_NO_TELEMETRY=1 ./node_modules/.bin/hyperframes browser path | grep -m1 '^/')" /opt/chrome-headless-shell \
 && test -x /opt/chrome-headless-shell \
 && chmod -R a+rX /opt/hf-home
ENV PRODUCER_HEADLESS_SHELL_PATH=/opt/chrome-headless-shell

COPY harness/ ./
COPY .agents/skills /app/.agents/skills

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/ ./

WORKDIR /app/harness
RUN chmod -R a+rX /app && chmod +x shims/npx bin/*.js

ENV NODE_ENV=production \
    SKILLS_DIR=.agents/skills \
    JOBS_DIR=jobs \
    SANDBOX_ENABLED=true \
    HYPERFRAMES_NO_TELEMETRY=1 \
    HYPERFRAMES_NO_UPDATE_CHECK=1

EXPOSE 8080

# Runs as root inside the container only so each job's commands can drop to their own uid.
ENTRYPOINT ["node", "bin/motion.js"]
CMD ["--help"]
