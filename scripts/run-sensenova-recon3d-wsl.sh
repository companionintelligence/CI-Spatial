#!/usr/bin/env bash
# Wait for the isolated runtime, then run a real multi-view reconstruction.
set -euo pipefail

ROOT=/mnt/c/devel/ci/CI-Spatial
RUNTIME="${ROOT}/.runtime/sensenova"
REPO="${RUNTIME}/SenseNova-Vision"
MODEL="${RUNTIME}/models/SenseNova-Vision-7B-MoT"
ENV_DIR=/opt/conda-envs/sensenova
SESSION="${ROOT}/scans/sessions/sess-photo-20260820-185834"
OUTPUT="${ROOT}/scans/.sensenova/recon3d-sess-photo-20260820-185834"

until [[ -f "${MODEL}/ema.safetensors" ]] && "${ENV_DIR}/bin/python" -c 'import torch, flash_attn' >/dev/null 2>&1; do
  sleep 30
done

images=$(printf '%s,' "${SESSION}"/kf-*.jpg)
images=${images%,}
mkdir -p "${OUTPUT}"
export PATH="${ENV_DIR}/bin:${PATH}"
export CUDA_HOME=/usr/local/cuda-12.5
export LD_LIBRARY_PATH="${CUDA_HOME}/lib64:${LD_LIBRARY_PATH:-}"
cd "${REPO}"
MODEL_PATH="${MODEL}" bash scripts/run_sensenova_vision.sh inference recon3d "" "${images}" --model_path "${MODEL}" --output_dir "${OUTPUT}"
