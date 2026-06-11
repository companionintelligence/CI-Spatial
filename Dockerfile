FROM denoland/deno:2.2.4

WORKDIR /app

# Copy server source from root
COPY main.ts inference.ts prompt.ts deno.json deno.lock ./

# Model files must be mounted at runtime — DO NOT bake 1.5 GB into the image.
# docker run -v /path/to/models:/app/public/models ...
# The models directory structure should be:
#   public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/
#     onnx/embed_tokens_fp16.onnx
#     onnx/embed_images_fp16.onnx
#     onnx/decoder_q4.onnx
#     tokenizer.json
#     tokenizer_config.json
#     preprocessor_config.json

# Pre-cache dependencies (requires network during build)
RUN deno cache main.ts

EXPOSE 8000

CMD ["deno", "run", \
     "--allow-net", \
     "--allow-read", \
     "--allow-write", \
     "--allow-env", \
     "--allow-ffi", \
     "main.ts"]
