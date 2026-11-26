import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_URL = process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000';

/** Suppress noisy `[vite] http proxy error: ECONNREFUSED` when backend is not running */
function silentProxyErrors(): Plugin {
  return {
    name: 'pinit-silent-proxy-errors',
    configureServer(server) {
      const originalError = server.config.logger.error.bind(server.config.logger);
      server.config.logger.error = (msg, options) => {
        const text = typeof msg === 'string' ? msg : String(msg ?? '');
        if (text.includes('http proxy error') || text.includes('ECONNREFUSED')) {
          return;
        }
        originalError(msg, options);
      };
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), silentProxyErrors()],
  // Production bundles drop console.log/info/debug (they printed project URLs, timings and user data).
  // console.warn/error stay so real failures are still visible.
  esbuild: command === 'build' ? { pure: ['console.log', 'console.info', 'console.debug'], drop: ['debugger'] } : {},
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    assetsDir: 'static',
    // Never publish source maps: they would hand the original source to anyone with devtools.
    sourcemap: false,
  },
  server: {
    host: '0.0.0.0',
    port: 3002,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        timeout: 600_000,
        proxyTimeout: 600_000,
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: 'Backend starting — waiting for API on port 4000 (npm run dev:all)',
                code: 'BACKEND_OFFLINE',
              }));
            }
          });
        },
      },
    },
  },
}));
