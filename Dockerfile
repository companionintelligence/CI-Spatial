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
COPY index.html scanner.html viewer.html webxr.html ./
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

# Server modules (splat_* / lingbot_map power the world-job queue)
COPY main.ts inference.ts prompt.ts jobs.ts pipeline.ts portal_auth.ts \
     lingbot_map.ts lingbot_map_glb.ts lingbot_map_ply.ts \
     splat_train.ts splat_train_dataset.ts splat_detect.ts splat_finish.ts \
     deno.json deno.lock ./
COPY src/world/ ./src/world/
COPY src/shared/ ./src/shared/

# Runtime worker scripts. The Python workers (lingbot-map, splat-detect) and
# the Brush trainer need GPU-capable hosts — install them on the host and point
# LINGBOT_MAP_PYTHON / SPLAT_DETECT_PYTHON / SPLAT_TRAIN_BIN at them; the jobs
# degrade gracefully (skippedReason) when the binaries are absent.
COPY scripts/lingbot_map_worker.py ./scripts/lingbot_map_worker.py
COPY scripts/ingest-video.mjs ./scripts/ingest-video.mjs
COPY scripts/ingest-photos.mjs ./scripts/ingest-photos.mjs

# Static viewer bundle from stage 1
COPY --from=web /web/dist ./dist

# Model files must be mounted at runtime — DO NOT bake 1.5 GB into the image:
#   docker run -v /path/to/models:/app/public/models ...
#
# Persist scans (uploads + optimized artifacts + keyframe sessions) and worlds:
#   docker run -v scans:/app/scans -v worlds:/app/worlds ...
RUN deno cache main.ts

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
     "main.ts"]
