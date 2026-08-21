#!/usr/bin/env python3
"""Download LFM2.5-VL-1.6B-ONNX model files for both browser and Deno server paths."""
from huggingface_hub import hf_hub_download
import os
import sys

# Windows consoles default to cp1252, which cannot encode non-ASCII output: a
# bare print() of any such character raises UnicodeEncodeError and aborts the
# download mid-run. Force UTF-8 where the runtime supports it, and degrade to a
# replacement character rather than crashing where it does not.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

MODEL_ID = "LiquidAI/LFM2.5-VL-1.6B-ONNX"
BASE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = f"{BASE}/public/models/{MODEL_ID}"

META = [
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "processor_config.json",
    "chat_template.jinja",
]

# Browser and server path: FP16 embed models + Q4 decoder (~1.5 GB)
ONNX_FILES = [
    "onnx/embed_tokens_fp16.onnx",
    "onnx/embed_tokens_fp16.onnx_data",
    "onnx/embed_images_fp16.onnx",
    "onnx/embed_images_fp16.onnx_data",
    "onnx/decoder_q4.onnx",
    "onnx/decoder_q4.onnx_data",
]

def dl(filename, local_dir):
    os.makedirs(local_dir, exist_ok=True)
    print(f"  -> {filename}", flush=True)
    hf_hub_download(repo_id=MODEL_ID, filename=filename, local_dir=local_dir)

print("=== Downloading model files ===")
for f in META + ONNX_FILES:
    dl(f, MODEL_DIR)

print("\nAll done.")
