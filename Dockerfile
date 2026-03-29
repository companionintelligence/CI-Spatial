FROM denoland/deno:2.2.4

WORKDIR /app

# Copy server source
COPY server/ ./server/

# Model files must be mounted at runtime — DO NOT bake 1.5 GB into the image.
# docker run -v /path/to/models:/app/server/models ...
# The models directory structure should be:
#   server/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/
#     onnx/embed_tokens.onnx
#     onnx/embed_images.onnx
#     onnx/decoder_model.onnx
#     tokenizer.json
#     tokenizer_config.json
#     preprocessor_config.json

# Pre-cache dependencies (requires network during build)
RUN deno cache server/main.ts

EXPOSE 8000

CMD ["deno", "run", \
     "--allow-net", \
     "--allow-read=/app/server/models", \
     "--allow-env=PORT,ALLOWED_ORIGIN", \
     "server/main.ts"]
