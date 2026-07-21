# ─────────────────────────────────────────────────────────────────────────────
# Maelle — container image for GKE.
#
# Multi-stage:
#   builder  — full Node image (ships python3 + build-essential + git) to compile
#              the better-sqlite3 native addon and run `tsc`.
#   runtime  — slim Node image; carries only dist/ + production node_modules +
#              the files the app reads at runtime (package.json, config/users.example).
#
# The SQLite DB and the owner config/state (config/users/) are NOT baked into the
# image — they live on a PersistentVolume mounted at runtime (see k8s/). The image
# is stateless and immutable; every deploy is a fresh, immutable tag.
#
# NOTE: replaces an earlier alpine stub. Alpine (musl libc) has no better-sqlite3
# prebuild and the stub shipped no build tools, so `npm ci` could not compile the
# addon; it also COPY'd a host-built (gitignored) dist/, which breaks in CI. This
# Debian multi-stage build compiles the addon itself and builds from source.
# ─────────────────────────────────────────────────────────────────────────────

# ---- builder ────────────────────────────────────────────────────────────────
FROM node:20-bookworm AS builder
WORKDIR /app

# better-sqlite3 compiles a native addon here. The full bookworm image already
# ships python3 + build-essential, so no extra apt install is needed.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies (typescript/eslint/…), keeping the compiled better-sqlite3
# binary and the prod tree — including @anthropic-ai/vertex-sdk, which is now a
# pinned production dependency in package.json (installed by `npm ci` above and
# kept by this prune), so no separate install step is needed.
RUN npm prune --omit=dev

# ---- runtime ────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Build stamp. The container has no .git, so getBuildStamp() reads these envs
# instead of shelling out to `git`. CI passes --build-arg GIT_SHA / APP_VERSION.
ARG GIT_SHA=unknown
ARG APP_VERSION=unknown
ENV GIT_SHA=${GIT_SHA}
ENV APP_VERSION=${APP_VERSION}

# Runtime artifacts only.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
# Template config only. The REAL config/users/ (idan.yaml + owner state) is
# mounted from the PVC at runtime and is intentionally absent from the image.
COPY config/users.example ./config/users.example

# Run as the image's built-in non-root uid 1000 (`node`).
USER node

CMD ["node", "dist/index.js"]
