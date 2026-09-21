# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
# The full image, not slim: better-sqlite3 has no prebuilt binary for every
# Node/arch combination and falls back to node-gyp, which needs python3 and a
# C++ toolchain. Only the build stage pays that weight; the runtime stays slim
# and inherits the already-compiled .node binary.
FROM node:22-bookworm AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy manifests first so dependency installation caches independently of source.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/database/package.json packages/database/
COPY packages/device-core/package.json packages/device-core/
COPY packages/module-adsb-monitor/package.json packages/module-adsb-monitor/
COPY packages/module-claude-usage/package.json packages/module-claude-usage/
COPY packages/module-sdk/package.json packages/module-sdk/
COPY packages/renderer/package.json packages/renderer/
COPY packages/secrets/package.json packages/secrets/
COPY packages/shared/package.json packages/shared/
COPY tools/claude-statusline-bridge/package.json tools/claude-statusline-bridge/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# `pnpm deploy` flattens the workspace into a self-contained tree, so the runtime
# image carries no symlinks into a workspace root that will not exist there.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --filter=@gca/server --prod --legacy /deploy

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV GCA_HOST=0.0.0.0
ENV GCA_PORT=3210
ENV GCA_DATA_DIR=/data

# Fonts are bundled with the renderer, so no system font packages are needed.
# tini reaps zombies and forwards signals so shutdown stays clean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /deploy ./
# `pnpm deploy` flattens the server to /app/dist, so the UI goes to the
# sibling `public` directory the server also looks in.
COPY --from=build /app/apps/web/dist ./public
COPY --from=build /app/tools/claude-statusline-bridge/dist ./tools/claude-statusline-bridge/dist

# Run unprivileged; the data volume is chowned to the same uid.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GCA_PORT||3210)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
