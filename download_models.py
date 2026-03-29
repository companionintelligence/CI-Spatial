#!/usr/bin/env python3
"""Download LFM2.5-VL-1.6B-ONNX model files for both browser and Deno server paths."""
from huggingface_hub import hf_hub_download
import os

MODEL_ID = "LiquidAI/LFM2.5-VL-1.6B-ONNX"
BASE = "/Users/liam/devel/3d/8th-scan/ci-xr-scan-web"
BROWSER_DIR = f"{BASE}/public/models/{MODEL_ID}"
SERVER_DIR = f"{BASE}/server/models/{MODEL_ID}"

META = [
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "processor_config.json",
    "chat_template.jinja",
]

# Browser path: FP16 embed models + Q4 decoder (~1.5 GB)
BROWSER_ONNX = [
    "onnx/embed_tokens_fp16.onnx",
    "onnx/embed_tokens_fp16.onnx_data",
    "onnx/embed_images_fp16.onnx",
    "onnx/embed_images_fp16.onnx_data",
    "onnx/decoder_q4.onnx",
    "onnx/decoder_q4.onnx_data",
]

def dl(filename, local_dir):
    os.makedirs(local_dir, exist_ok=True)
    print(f"  ↓ {filename}", flush=True)
    hf_hub_download(repo_id=MODEL_ID, filename=filename, local_dir=local_dir)

print("=== Downloading browser model files ===")
for f in META + BROWSER_ONNX:
    dl(f, BROWSER_DIR)

print("\n=== Downloading server model files ===")
# Config files
for f in META:
    dl(f, SERVER_DIR)

# embed_tokens (fp32, no data shard — small file)
dl("onnx/embed_tokens.onnx", SERVER_DIR)

# Symlink shared ONNX files (embed_images_fp16 + decoder_q4) to avoid re-downloading ~1 GB
onnx_browser = f"{BROWSER_DIR}/onnx"
onnx_server = f"{SERVER_DIR}/onnx"
os.makedirs(onnx_server, exist_ok=True)

shared = [
    "embed_images_fp16.onnx",
    "embed_images_fp16.onnx_data",
    "decoder_q4.onnx",
    "decoder_q4.onnx_data",
]
for fname in shared:
    src = f"{onnx_browser}/{fname}"
    dst = f"{onnx_server}/{fname}"
    if not os.path.exists(dst):
        os.symlink(src, dst)
        print(f"  ↔ symlinked {fname}")
    else:
        print(f"  ✓ already exists: {fname}")

print("\nAll done.")
