import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    // Listen on all interfaces so Tailscale can reach it at
    // https://liam-mbp.capybara-ulmer.ts.net:5173
    host: '0.0.0.0',
    port: 5173,
    https: true,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // @huggingface/transformers provides its own ONNX backend;
    // don't pre-bundle it — it manages its WASM assets at runtime.
    exclude: ['@huggingface/transformers'],
  },
})
