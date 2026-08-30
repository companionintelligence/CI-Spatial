# Companion Scan — single-container image for CI-Hub marketplace installs.
#
# Stage 1 builds the Vite static bundle (scanner + editor UI); stage 2 is the
# Deno API server, which also serves that bundle via the STATIC_DIR
# fall-through in server/main.ts — one container, one port (8000), UI + API.

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
# entry it names is missing from the context. Same failure mode the server
# module copy below avoids, one stage earlier.
COPY *.html ./
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/copy-draco.mjs ./scripts/copy-draco.mjs
RUN node scripts/copy-draco.mjs && npx vite build

# Stage 2 — Deno server + workers
FROM denoland/deno:2.8.3
WORKDIR /app

# node + ffmpeg power the /ingest-video and /ingest-photos routes (server/main.ts
# spawns `node scripts/ingest-*.mjs`, which shell out to ffmpeg/ffprobe).
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Server modules. `COPY server/ ./server/` grabs the whole directory rather than
# a hand-maintained file list — the previous approach (an explicit COPY list,
# then a *.ts glob at the repo root) twice fell behind as server/main.ts grew
# new static imports the list didn't name, breaking `deno cache` here without
# anyone noticing (publishing is workflow_dispatch-only). A directory copy
# can't have that failure mode: it structurally cannot omit a file that exists
# under server/. `*.ts` at the root now only matches vite.config.ts and
# playwright.config.ts (everything server-side now lives under server/), so
# it's kept as a harmless glob rather than deleted, for the same reason: it's
# what stops the next root-level module from silently missing the build
# instead of failing it.
COPY *.ts deno.json deno.lock ./
COPY server/ ./server/
COPY src/world/ ./src/world/
COPY src/shared/ ./src/shared/

# Runtime worker scripts. The Python workers (lingbot-map, splat-detect) and
# the Brush trainer need GPU-capable hosts — install them on the host and point
# LINGBOT_MAP_PYTHON / SPLAT_DETECT_PYTHON / SPLAT_TRAIN_BIN at them; the jobs
# degrade gracefully (skippedReason) when the binaries are absent.
# NOTE: these are spawned by server/main.ts at runtime, so their own imports must be
# here too — ingest-{video,photos}.mjs both `import './ingest-quality.mjs'`.
# A miss here is invisible at build time and only shows up as a 500 from the
# ingest routes in a real install.
COPY scripts/lingbot_map_worker.py ./scripts/lingbot_map_worker.py
# Both Python workers import this sibling for device selection (NVIDIA/AMD/
# Apple/CPU). Omitting it does not fail the build — the workers degrade to
# 'skipped' with a copy hint at run time, which reads like a missing GPU tool
# rather than a missing file. Keep it beside the workers.
COPY scripts/_torch_device.py ./scripts/_torch_device.py
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
