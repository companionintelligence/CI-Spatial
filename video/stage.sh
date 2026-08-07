#!/usr/bin/env bash
#
# Companion Scan's stage, for local video capture. Sourced by video/make.sh,
# which owns the generic capture/build/check/render steps; this file only has to
# get the app running and stop it again.
#
# It is a THIN WRAPPER around scripts/video-stage.mjs, which is this repo's own
# purpose-built capture stage and the thing that is maintained alongside the app.
# This file's whole job is to pick free ports, hand them over, wait, and tear it
# down again — the staging logic itself lives in the Node script.
#
# ── Why this delegates instead of doing it itself ────────────────────────────
# It used to inline the two-server sequence documented at the top of
# video/capture.config.mjs: start Deno, `COUNT=3 npm run seed:test-data`, start
# Vite. That sequence is subtly wrong, and every one of its defects reached the
# committed screenshots as a plausible-looking frame rather than a failure:
#
#   1. `COUNT=3` seeds a PREFIX of test-data/homes/index.json, which is ordered
#      archetype-major with A/B/C variants — so the World Editor filmed
#      "Studio Apartment A", "Studio Apartment B" and "Studio Apartment C", three
#      ±12% rescalings of one room. The World Editor's entire claim is that
#      separate scans of separate rooms assemble into one world; a scan list of
#      three same-named rooms argues the opposite. seed-test-homes.mjs grew a
#      HOMES selector for exactly this, and its own comment names
#      scripts/video-stage.mjs as the caller that uses it.
#   2. Seeded homes are 0.0011 deg of latitude — about 122 m — apart, so "3 scans
#      loaded" filmed ONE room with the other two off-camera, and flung their
#      semantic labels into the top-right corner on top of #inspector-panel,
#      covering the Room and Floor readouts. video-stage.mjs re-places the homes
#      ~8.8 m apart before seeding so all three are genuinely in frame.
#   3. Nothing waited for the background optimize jobs, so the World Editor shots
#      could film a half-loaded world. video-stage.mjs blocks on /jobs until every
#      optimize-scan is done, and fails loudly if one errors.
#
# Keep this file thin. If the stage needs to change, change video-stage.mjs — it
# is what a developer runs by hand, so a fix there is a fix for both paths.
#
# No device and no SLAM binary are needed. Every `/?mock=xr8` shot goes through
# public/test-fixtures/xr8-mock.js, a drop-in replacement for the 8th Wall
# engine that flies a scripted camera through a synthetic room. The API runs with
# INFERENCE_MODE=mock (set by video-stage.mjs), a colour-blob detector that needs
# only jimp — no model download, no GPU.

STAGE_PID=""
STAGE_DATA=""

stage_up() {
  # Never reuse a port somebody else holds: a capture against another server
  # succeeds, produces plausible screenshots and is completely wrong — the
  # failure mode this pipeline exists to avoid. Relocate instead of failing;
  # video-stage.mjs passes API_TARGET to Vite, so its proxy follows the API.
  #
  # Several agents stage different repos on this workspace at once, so both
  # ports genuinely do move.
  STAGE_PORT="$(pick_port 5173)"
  API_PORT="$(pick_port 8000)"

  # HTTPS, not HTTP: vite.config.ts serves the dev server over TLS
  # (@vitejs/plugin-basic-ssl when no Tailscale cert is present). capture.config
  # reads APP_URL, so the kit follows a relocation.
  STAGE_URL="https://localhost:$STAGE_PORT"
  export APP_URL="$STAGE_URL"
  [ "$STAGE_PORT" = 5173 ] || echo "note: :5173 was busy, using :$STAGE_PORT"
  [ "$API_PORT" = 8000 ]  || echo "note: :8000 was busy, using :$API_PORT"

  # `deno install`, NOT `npm ci`. deno.json sets "nodeModulesDir": "auto", so
  # Deno owns node_modules here and installs the npm: specifiers its own import
  # map declares. `npm ci` installs from package-lock and leaves out packages the
  # scripts need — @gltf-transform/core among them, which makes generate-test-homes
  # die with ERR_MODULE_NOT_FOUND on a clean checkout. Deno installs both those
  # and vite, and video-stage.mjs runs vite through node_modules/vite/bin/vite.js,
  # so this install is what puts it there.
  ( cd "$REPO_ROOT" && deno install )

  # A per-run data dir, not video-stage.mjs's shared default under $TMPDIR: two
  # agents staging this repo at once would otherwise wipe each other's world on
  # boot (the script rmSync's it), and the loser films an empty World Editor.
  STAGE_DATA="$(mktemp -d -t ci-video-scan)"

  # video-stage.mjs generates the fixtures, places the homes adjacent, starts the
  # API on isolated dirs, seeds one home per archetype, waits for every optimize
  # job to finish, then runs Vite in the foreground. It blocks, so background it
  # and poll.
  ( cd "$REPO_ROOT" \
      && VIDEO_PORT="$STAGE_PORT" \
         VIDEO_API_PORT="$API_PORT" \
         VIDEO_DATA_DIR="$STAGE_DATA" \
         node scripts/video-stage.mjs ) > "$STAGE_LOG" 2>&1 &
  STAGE_PID=$!

  # -k: the dev cert is self-signed unless a Tailscale cert happens to be
  # present. The kit's browser context ignores HTTPS errors for the same reason.
  #
  # Generous timeout: this waits on fixture generation, three GLB uploads and
  # their optimize jobs, not just a dev server binding a port.
  for _ in $(seq 1 240); do
    curl -ksfo /dev/null "$STAGE_URL" && break
    kill -0 "$STAGE_PID" 2>/dev/null || { echo "video-stage.mjs exited during startup" >&2; return 1; }
    sleep 1
  done
  curl -ksfo /dev/null "$STAGE_URL" \
    || { echo "dev server never answered on :$STAGE_PORT" >&2; return 1; }

  # The stage is only ready when the API answers too — Vite proxies /worlds and
  # /infer to it, and a shot against a dead API films "Failed to load world: …"
  # rather than failing.
  curl -sfo /dev/null "http://localhost:$API_PORT/health" \
    || { echo "API never answered on :$API_PORT" >&2; return 1; }

  echo "stage up at $STAGE_URL (API on :$API_PORT)"
}

stage_down() {
  # Kill the CHILDREN first, then the wrapper. video-stage.mjs spawns deno and
  # vite and traps SIGTERM to take them with it, but if it has already gone the
  # children would be left holding the ports.
  #
  # Deliberately NOT `kill -- -<pgid>`: a background job in a non-interactive
  # shell shares the script's own process group, so signalling the group kills
  # make.sh too.
  if [ -n "$STAGE_PID" ] && kill -0 "$STAGE_PID" 2>/dev/null; then
    pkill -P "$STAGE_PID" 2>/dev/null || true
    kill "$STAGE_PID" 2>/dev/null || true
    wait "$STAGE_PID" 2>/dev/null || true
  fi

  # Either server can outlive its parent if it re-parented; make sure the ports
  # are free, or the next run refuses to start on one it thinks is taken.
  for _ in $(seq 1 10); do
    if ! curl -ksfo /dev/null "$STAGE_URL" && ! curl -sfo /dev/null "http://localhost:${API_PORT:-8000}/health"; then
      [ -n "$STAGE_DATA" ] && rm -rf "$STAGE_DATA"
      return 0
    fi
    sleep 1
  done
  echo "warning: something is still answering $STAGE_URL or :$API_PORT" >&2
  [ -n "$STAGE_DATA" ] && rm -rf "$STAGE_DATA"
}
