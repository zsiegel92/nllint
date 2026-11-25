import { defineConfig } from 'vite';

export default defineConfig(() => {
  const target = new URL(process.env.NLLINT_VITE_BACKEND_URL || 'http://127.0.0.1:8080');
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
    || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('BACKEND_URL must be an HTTP or HTTPS origin');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  const proxy = { target: target.origin, changeOrigin: !local };
  return { server: { proxy: { '/api': proxy, '/healthz': proxy, '/v1': proxy } } };
});
