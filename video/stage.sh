#!/usr/bin/env bash
#
# Companion Scan's stage, for local video capture. Sourced by video/make.sh,
# which owns the generic capture/build/check/render steps; this file only has to
# get the app running and stop it again.
#
# TWO servers, not one — this is the manual sequence documented at the top of
# video/capture.config.mjs, made repeatable. Vite alone is not enough: the
# storyboard films the World Editor and the detections panel, and both are
# backed by the Deno API.
#
# No device and no SLAM binary are needed. Every `/?mock=xr8` shot goes through
# public/test-fixtures/xr8-mock.js, a drop-in replacement for the 8th Wall
# engine that flies a scripted camera through a synthetic room.

API_PID=""
STAGE_PID=""
STAGE_DATA=""

stage_up() {
  # Never reuse a port somebody else holds: a capture against another server
  # succeeds, produces plausible screenshots and is completely wrong — the
  # failure mode this pipeline exists to avoid. Relocate instead of failing;
  # both the kit and Vite's API proxy are told where things actually landed.
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
  # scripts need — @gltf-transform/core among them, which makes gen:test-data
  # die with ERR_MODULE_NOT_FOUND on a clean checkout. Deno installs both those
  # and vite, so one install serves the API, the app and the fixture scripts.
  ( cd "$REPO_ROOT" && deno install )

  # Deterministic fixtures: fixed seed and a fixed timestamp, so the homes are
  # identical run to run. Idempotent, and slow enough to be worth skipping once
  # it has been done.
  if [ ! -f "$REPO_ROOT/test-data/homes/index.json" ]; then
    ( cd "$REPO_ROOT" && npm run gen:test-data )
  fi

  # Isolated data dirs, so a capture never writes into the checkout. The API
  # would otherwise scatter uploaded scans, optimized GLBs and world state
  # through ./scans, ./worlds and ./summaries.
  STAGE_DATA="$(mktemp -d -t ci-video-scan)"

  # INFERENCE_MODE=mock keeps this cheap and deterministic: the mock engine is a
  # colour-blob detector needing only jimp, so there is no model download and no
  # GPU. It recognises the same palette the xr8 mock paints, so /infer returns
  # the same objects every run.
  ( cd "$REPO_ROOT" \
      && INFERENCE_MODE=mock \
         PORT="$API_PORT" \
         SCANS_DIR="$STAGE_DATA/scans" \
         WORLDS_DIR="$STAGE_DATA/worlds" \
         SUMMARIES_DIR="$STAGE_DATA/summaries" \
         npm run server ) > "$STAGE_LOG" 2>&1 &
  API_PID=$!

  for _ in $(seq 1 60); do
    curl -sfo /dev/null "http://localhost:$API_PORT/health" && break
    kill -0 "$API_PID" 2>/dev/null || { echo "API exited during startup" >&2; return 1; }
    sleep 1
  done
  curl -sfo /dev/null "http://localhost:$API_PORT/health" \
    || { echo "API never answered on :$API_PORT" >&2; return 1; }

  # Three homes into world "default" — seeded through the API, not by writing
  # its data dirs, so the server owns its own state. COUNT=3 is what the
  # storyboard's World Editor and detections shots expect to find.
  ( cd "$REPO_ROOT" && COUNT=3 SERVER_URL="http://localhost:$API_PORT" npm run seed:test-data ) \
    >> "$STAGE_LOG" 2>&1 || { echo "seeding failed" >&2; return 1; }

  # TAILSCALE_HOSTNAME=localhost pins the hostname Vite serves and allows;
  # API_TARGET points its proxy at the API we actually started, so a relocated
  # API port does not silently break every /infer call in the capture.
  ( cd "$REPO_ROOT" \
      && TAILSCALE_HOSTNAME=localhost \
         API_TARGET="http://localhost:$API_PORT" \
         npm run dev -- --port "$STAGE_PORT" ) >> "$STAGE_LOG" 2>&1 &
  STAGE_PID=$!

  # -k: the dev cert is self-signed unless a Tailscale cert happens to be
  # present. The kit's browser context ignores HTTPS errors for the same reason.
  for _ in $(seq 1 60); do
    curl -ksfo /dev/null "$STAGE_URL" && break
    kill -0 "$STAGE_PID" 2>/dev/null || { echo "dev server exited during startup" >&2; return 1; }
    sleep 1
  done
  curl -ksfo /dev/null "$STAGE_URL" || { echo "dev server never answered on :$STAGE_PORT" >&2; return 1; }
  echo "stage up at $STAGE_URL (API on :$API_PORT)"
}

stage_down() {
  # Kill each server's CHILDREN first, then the npm wrapper. `npm run dev`
  # spawns vite as a child and `npm run server` spawns deno, and killing only
  # npm leaves the child holding the port.
  #
  # Deliberately NOT `kill -- -<pgid>`: a background job in a non-interactive
  # shell shares the script's own process group, so signalling the group kills
  # make.sh too.
  for pid in "$STAGE_PID" "$API_PID"; do
    [ -n "$pid" ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done

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
