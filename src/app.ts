/**
 * PINIT-DNA — Application Entry Point (stripped to face-only register / sign-in / welcome)
 */

import './bootstrap-env';

import 'express-async-errors';
import fs   from 'fs';
import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createSharedRateLimitStore } from './lib/rate-limit-store';

import { config } from './config';
import { logger } from './lib/logger';
import { authRouter } from './api/routes/auth.routes';
import { requireAuth } from './api/middleware/auth.middleware';
import { requireAdminOrSuper } from './api/middleware/role.middleware';
import { publicHealth, detailedHealth } from './api/controllers/health.controller';
import { getOpsSnapshot } from './lib/ops-metrics';
import { errorMiddleware } from './api/middleware/error.middleware';
import { apiJsonPolicy, pagePolicyReportOnly } from './api/middleware/security-headers';
import { requestIdMiddleware } from './api/middleware/request-id.middleware';

const app = express();

// ─── Static UI ────────────────────────────────────────────────────────────────
// Serve React build (client/dist) if it exists, otherwise fall back to public/
const reactBuildPath = path.join(__dirname, '..', 'client', 'dist');
const publicPath     = path.join(__dirname, '..', 'public');

if (fs.existsSync(reactBuildPath)) {
  app.use(express.static(reactBuildPath));
} else {
  app.use(express.static(publicPath));
}

// ─── Trust proxy (Render/Vercel/ngrok) — 1 hop only to avoid rate-limit bypass warning
app.set('trust proxy', 1);

// ─── Request correlation (PGAP-11) ────────────────────────────────────────────
// First in the stack so every later middleware's logs — morgan's access log,
// a route handler, the error handler — already run inside this request's
// AsyncLocalStorage context.
app.use(requestIdMiddleware);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(config.apiPrefix, apiJsonPolicy);
app.use(pagePolicyReportOnly(config.apiPrefix));

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Allows: localhost + ngrok + Vercel + Pinit HUB custom domains + ALLOWED_ORIGIN(S)
app.use(cors({
  origin: (origin, callback) => {
    // No origin = server-to-server, Postman, curl → always allow
    if (!origin) return callback(null, true);

    if (origin.startsWith('chrome-extension://') || origin.startsWith('extension://')) {
      return callback(null, true); // scheme-anchored — not vulnerable to the substring issue below
    }

    const extraOrigins = [
      process.env['ALLOWED_ORIGIN'] ?? '',
      ...(process.env['ALLOWED_ORIGINS'] ?? '').split(','),
    ]
      .map((value) => value.trim())
      .filter(Boolean);

    if (extraOrigins.includes(origin)) return callback(null, true);

    // Hostname-anchored, not substring (origin.includes('vercel.app') would
    // also match an attacker-registered host like
    // "vercel.app.evil-attacker.com" — confirmed exploitable, since
    // credentials: true below means a matching origin gets the refresh-token
    // cookie sent along with its cross-origin requests). hostname.endsWith
    // still requires a real subdomain relationship, not just the substring
    // appearing anywhere in the string.
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      logger.warn('CORS: origin denied (unparseable)', { origin });
      return callback(null, false);
    }

    const isSubdomainOrExact = (host: string, base: string) =>
      host === base || host.endsWith(`.${base}`);

    const allowed =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      isSubdomainOrExact(hostname, 'ngrok.io') ||
      isSubdomainOrExact(hostname, 'ngrok-free.app') ||
      isSubdomainOrExact(hostname, 'ngrok-free.dev') ||
      isSubdomainOrExact(hostname, 'ngrok.app') ||
      isSubdomainOrExact(hostname, 'vercel.app') ||       // Vercel preview + production
      isSubdomainOrExact(hostname, 'pinithub.com');       // custom domain (apex + www)

    if (allowed) return callback(null, true);

    // Log denied origins for debugging — do NOT throw, just deny
    logger.warn('CORS: origin denied', { origin });
    return callback(null, false);   // ← returns 403, NOT 500
  },
  credentials: true,
}));

// ─── Request logging ──────────────────────────────────────────────────────────
app.use(
  morgan('dev', {
    stream: { write: (msg) => logger.http(msg.trim()) },
  })
);

// ─── Body parsers ─────────────────────────────────────────────────────────────
// Was 1mb. Face registration now bundles 3 enrollment rounds' worth of PAD evidence per
// request, including a color JPEG crop per sampled frame (MiniFASNet passive PAD input,
// see minifasnet-pad.service.ts) alongside the existing grayscale motion patches —
// comfortably over 1mb in the worst case (many samples, well-lit detailed crops).
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Phase 4: shared Redis store when REDIS_ENABLED=true, else undefined — which
// falls back to express-rate-limit's own default in-memory store, i.e.
// exactly today's behavior. fail-open: a Redis blip must never take down the
// whole API over a secondary, defense-in-depth control.
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) =>
    process.env['NODE_ENV'] !== 'production' ||
    req.path === '/health' ||
    req.path === `${config.apiPrefix}/ping` ||
    req.path === `${config.apiPrefix}/health`,
  store: createSharedRateLimitStore({ prefix: 'rl:global:', windowMs: config.rateLimit.windowMs, failurePolicy: 'fail-open' }),
});

// ─── Health check (Phase 6 — detailed) — before rate limiter ─────────────────
/** Instant liveness — used by Vite proxy / dev auto-retry (no DB). */
app.get(`${config.apiPrefix}/ping`, (_req, res) => {
  res.json({ ok: true, service: 'pinit-dna-api', ts: Date.now() });
});

// Public health shows only the verdict; the full report is for signed-in admins (controllers/health.controller.ts).
app.get(`${config.apiPrefix}/health`, publicHealth);
app.get('/health', publicHealth);
app.get(`${config.apiPrefix}/health/details`, requireAuth, requireAdminOrSuper, detailedHealth);
// Event-loop delay, memory, heavy-work lines and outcome counters (lib/ops-metrics.ts). Admin only; reading it starts a new window.
app.get(`${config.apiPrefix}/ops/metrics`, requireAuth, requireAdminOrSuper, (_req, res) => {
  res.json({ success: true, ...getOpsSnapshot() });
});

app.use(apiLimiter);

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use(`${config.apiPrefix}/auth`, authRouter);

// ─── React SPA catch-all ─────────────────────────────────────────────────────
// Serves index.html for /login, /register, /welcome etc. (client-side routing)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ success: false, error: 'Route not found' });
    return;
  }
  const reactIndex = path.join(__dirname, '..', 'client', 'dist', 'index.html');
  if (fs.existsSync(reactIndex)) {
    res.sendFile(reactIndex);
  } else {
    res.status(404).json({ success: false, error: 'Route not found' });
  }
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use(errorMiddleware);

export { app };
