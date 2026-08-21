#!/usr/bin/env bash
# Install SenseNova's supported Linux runtime without touching Windows Python.
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/mnt/c/devel/ci/CI-Spatial}"
RUNTIME_ROOT="${PROJECT_ROOT}/.runtime/sensenova"
REPO_DIR="${RUNTIME_ROOT}/SenseNova-Vision"
MODEL_DIR="${RUNTIME_ROOT}/models/SenseNova-Vision-7B-MoT"
CONDA_BIN=/opt/miniforge3/bin/conda
ENV_DIR=/opt/conda-envs/sensenova
# NVIDIA's current Ubuntu 24.04 repository retains 12.5 as its oldest CUDA 12
# toolkit. SenseNova documents CUDA 12.x support, so this is the closest
# supported package when the reference 12.4 package is no longer published.
CUDA_HOME=/usr/local/cuda-12.5

[[ "${EUID}" -eq 0 ]] || { echo "Run as root inside WSL." >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
# CUDA 12.5 rejects Ubuntu 24.04's default GCC 14. FlashAttention is compiled
# locally, so pin its host compiler to the supported GCC/G++ 13 toolchain.
apt-get install -y git curl bzip2 build-essential gcc-13 g++-13
if [[ ! -x "${CONDA_BIN}" ]]; then
  curl -fsSL https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh -o /tmp/Miniforge3.sh
  bash /tmp/Miniforge3.sh -b -p /opt/miniforge3
fi
if [[ ! -x "${CUDA_HOME}/bin/nvcc" ]]; then
  curl -fsSL https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb -o /tmp/cuda-keyring.deb
  dpkg -i /tmp/cuda-keyring.deb
  apt-get update
  apt-get install -y cuda-toolkit-12-5
fi
mkdir -p "${RUNTIME_ROOT}/models"
[[ -d "${REPO_DIR}/.git" ]] || git clone --depth 1 https://github.com/OpenSenseNova/SenseNova-Vision.git "${REPO_DIR}"
[[ -x "${ENV_DIR}/bin/python" ]] || "${CONDA_BIN}" create -y -p "${ENV_DIR}" python=3.10.16 pip=25.1 setuptools=78.1.1 wheel=0.45.1
export PATH="${ENV_DIR}/bin:${PATH}" CUDA_HOME LD_LIBRARY_PATH="${CUDA_HOME}/lib64:${LD_LIBRARY_PATH:-}"
export CC=/usr/bin/gcc-13 CXX=/usr/bin/g++-13
python -m pip install --upgrade pip
python -m pip install --index-url https://download.pytorch.org/whl/cu124 torch==2.5.1 torchvision==0.20.1
grep -vE '^(torch|torchvision)==' "${REPO_DIR}/requirements.txt" > /tmp/sensenova-requirements.txt
python -m pip install -r /tmp/sensenova-requirements.txt -c "${REPO_DIR}/constraints.txt"
python -m pip install flash-attn==2.6.3 --no-build-isolation
python -m pip install "panopticapi @ https://github.com/cocodataset/panopticapi/archive/7bb4655548f98f3fedc07bf37e9040a992b054b0.zip" -c "${REPO_DIR}/constraints.txt"
python -m pip install -e "${REPO_DIR}/tools/evaluation/detect/evaluation/fastevaluate"
python -m pip install -r "${REPO_DIR}/tools/evaluation/recons/requirements.txt" huggingface_hub==0.29.1
[[ -f "${MODEL_DIR}/ema.safetensors" ]] || python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='sensenova/SenseNova-Vision-7B-MoT', local_dir='${MODEL_DIR}')"
python -c "import decord, fastevaluate, flash_attn, panopticapi, torch; print('torch=' + torch.__version__ + ' cuda=' + str(torch.version.cuda) + ' gpu=' + torch.cuda.get_device_name(0) + ' flash_attn=' + flash_attn.__version__ + ' runtime=ok')"
