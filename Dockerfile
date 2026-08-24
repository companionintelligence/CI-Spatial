# Companion Scan — single-container image for CI-Hub marketplace installs.
#
# Stage 1 builds the Vite static bundle (scanner + editor UI); stage 2 is the
# Deno API server, which also serves that bundle via the STATIC_DIR
# fall-through in main.ts — one container, one port (8000), UI + API.

# Stage 1 — build the static viewer bundle (vite)
FROM node:22-alpine AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json vite.config.ts ./
# Root .ts is now only vite.config.ts/playwright.config.ts (thing_tags moved to
# src/shared/, which COPY src/ already covers). Kept as a glob rather than
# deleted: it costs nothing and it is what stops the next browser-imported root
# module from silently failing the bundle, which is how this line was earned.
COPY *.ts ./
# Every root HTML file. Also a glob: vite.config.ts's `input` map grew
# ar-hittest-sphere.html (#115) and ar-ground-anchor.html (wave 09) after this
# line was written, and Vite fails the build with UNRESOLVED_ENTRY when an
# entry it names is missing from the context. Same failure mode as the server
# module list below, one stage earlier.
COPY *.html ./
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/copy-draco.mjs ./scripts/copy-draco.mjs
RUN node scripts/copy-draco.mjs && npx vite build

# Stage 2 — Deno server + workers
FROM denoland/deno:2.8.3
WORKDIR /app

# node + ffmpeg power the /ingest-video and /ingest-photos routes (main.ts
# spawns `node scripts/ingest-*.mjs`, which shell out to ffmpeg/ffprobe).
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Server modules. A glob, deliberately, not a hand-maintained list: the previous
# explicit list was last updated 2026-08-05 and main.ts had since grown static
# imports of nine modules it never named (world_job_pump/lock/membership/prune,
# scan_id, scan_index, sensenova_vision, session_id, thing_match). `deno cache
# main.ts` below fails on the first of them, so the image has not built since
# 2026-08-16 — and nothing noticed, because publishing is workflow_dispatch-only
# and the CI-Marketplace manifest pins the :latest built before the break.
# The list was the bug; enumerating it correctly would only reset the clock.
COPY *.ts deno.json deno.lock ./
COPY server/ ./server/
COPY src/world/ ./src/world/
COPY src/shared/ ./src/shared/

# Runtime worker scripts. The Python workers (lingbot-map, splat-detect) and
# the Brush trainer need GPU-capable hosts — install them on the host and point
# LINGBOT_MAP_PYTHON / SPLAT_DETECT_PYTHON / SPLAT_TRAIN_BIN at them; the jobs
# degrade gracefully (skippedReason) when the binaries are absent.
# NOTE: these are spawned by main.ts at runtime, so their own imports must be
# here too — ingest-{video,photos}.mjs both `import './ingest-quality.mjs'`.
# A miss here is invisible at build time and only shows up as a 500 from the
# ingest routes in a real install.
COPY scripts/lingbot_map_worker.py ./scripts/lingbot_map_worker.py
COPY scripts/ingest-video.mjs ./scripts/ingest-video.mjs
COPY scripts/ingest-photos.mjs ./scripts/ingest-photos.mjs
COPY scripts/ingest-quality.mjs ./scripts/ingest-quality.mjs

# Static viewer bundle from stage 1
COPY --from=web /web/dist ./dist

# Model files must be mounted at runtime — DO NOT bake 1.5 GB into the image:
#   docker run -v /path/to/models:/app/public/models ...
#
# Persist scans (uploads + optimized artifacts + keyframe sessions) and worlds:
#   docker run -v scans:/app/scans -v worlds:/app/worlds ...
RUN deno cache server/main.ts

EXPOSE 8000

# --allow-run is required for the world jobs (python/brush) and the
# ingest routes (node); see PR #22.
CMD ["deno", "run", \
     "--allow-net", \
     "--allow-read", \
     "--allow-write", \
     "--allow-env", \
     "--allow-ffi", \
     "--allow-run", \
     "server/main.ts"]
