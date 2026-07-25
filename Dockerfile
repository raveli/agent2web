# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for linux/amd64 and linux/arm64; the
# toolchain is here only so a build for another platform can fall back to source.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Reinstall without dev dependencies so the runtime stage copies a lean tree.
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    A2W_DATA_DIR=/data \
    A2W_PORT=8080
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./

# uid/gid 10001 keeps the volume ownership predictable across hosts.
RUN groupadd --gid 10001 agent2web \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin agent2web \
 && mkdir -p /data && chown -R 10001:10001 /data

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.A2W_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/src/index.js"]
