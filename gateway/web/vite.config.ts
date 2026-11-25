import { defineConfig } from 'vite';

const backend = 'http://127.0.0.1:8080';

export default defineConfig({
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/healthz': backend,
      '/v1': backend,
    },
  },
});
