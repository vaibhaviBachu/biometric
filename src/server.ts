/**
 * PINIT-DNA — HTTP server bootstrap (single listen per process)
 * Reload: spatial auth env flags (SPATIAL_*); Exchange listed-assets route.
 *
 * Use this entry for dev (ts-node-dev) and production (node dist/server.js).
 * app.ts exports the Express app only — no app.listen() there.
 */

// Must stay the first import: a local server refuses production data before anything else loads.
import './config/local-isolation-check';
import http from 'http';
import path from 'path';
import type { Express } from 'express';
import { app } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { registerGracefulShutdown, setActiveServer } from './lib/graceful-shutdown';
import { checkProductionSecretSafety, runSecretValidation } from './config/secret-safety';
import { startRuntimeWatch } from './lib/runtime-watch';
import { startOpsMetrics } from './lib/ops-metrics';

let httpServer: http.Server | null = null;
let bootstrapped = false;

function listenWithRetry(expressApp: Express, port: number, maxAttempts = 10): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = () => {
      attempt++;
      const server = expressApp.listen(port);

      server.once('listening', () => resolve(server));

      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close();

        if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
          if (attempt === 1 && config.env !== 'production') {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              require(path.join(__dirname, '..', 'scripts', 'free-dev-ports.cjs'));
            } catch {
              /* non-fatal */
            }
          }
          logger.warn(`Port ${port} in use — waiting for previous instance to release (${attempt}/${maxAttempts})`);
          setTimeout(tryListen, 750);
          return;
        }

        reject(err);
      });
    };

    tryListen();
  });
}

async function onServerReady(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production' && process.env['RENDER_EXTERNAL_URL']) {
    const keepAliveUrl = `${process.env['RENDER_EXTERNAL_URL']}/api/v1/health`;
    setInterval(() => {
      void import('https').then(({ default: https }) =>
        https.get(keepAliveUrl, () => {}).on('error', () => {}),
      );
    }, 14 * 60 * 1000);
    logger.info('Keep-alive ping enabled', { url: keepAliveUrl });
  }
}

export async function startHttpServer(): Promise<http.Server> {
  if (httpServer?.listening) {
    logger.warn('HTTP server already listening — ignoring duplicate start');
    return httpServer;
  }

  checkProductionSecretSafety();
  runSecretValidation();

  registerGracefulShutdown();

  httpServer = await listenWithRetry(app, config.port);

  setActiveServer(httpServer);

  if (!bootstrapped) {
    bootstrapped = true;
    logger.info('PINIT-DNA API running', {
      port: config.port,
      env: config.env,
      prefix: config.apiPrefix,
      engineVersion: config.dna.engineVersion,
    });
    startRuntimeWatch();
    startOpsMetrics();
    void onServerReady();
  }

  return httpServer;
}

if (require.main === module) {
  startHttpServer().catch((err) => {
    logger.error('Failed to start HTTP server', { error: String(err) });
    process.exit(1);
  });
}
