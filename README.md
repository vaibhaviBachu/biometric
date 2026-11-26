# PINIT — Face-Only Biometric Sign-In

> Register and sign in with your face. No passwords, no email, no username — a Pinit ID is minted at registration and your face is the only credential after that.

This is a stripped-down, hardened build of a larger product ("PinIt Hub"). Everything that wasn't register / sign-in / welcome — the Hub dashboard, Exchange marketplace, Vault file storage, DNA/forensics tooling, subscriptions, crawler/monitoring, the browser extension, the separate admin and landing apps — has been removed. What's left is a small, complete biometric auth system: three screens, one API surface, one database.

---

## What it does

1. **Register** (`/register`) — capture a live face (liveness-gated, see below), generate a 128-d face embedding client-side, send it to the server along with the liveness evidence. The server verifies liveness, checks the face isn't already enrolled, encrypts and stores the embedding, and mints a random Pinit ID (`PINIT-XXXXXXXX`).
2. **Sign in** (`/login`) — capture a live face again. The server re-verifies liveness, then either matches it 1:1 against a claimed Pinit ID or 1:N against every enrolled face (no ID typed at all). A match signs you in; no match returns one generic denial, nothing more specific.
3. **Welcome** (`/welcome`) — the only screen a signed-in user lands on: "Hello, welcome! You're signed in as `<Pinit ID>`" and a sign-out button. No dashboard, no nav, no other features.

## Liveness: two independent checks, both must pass

A still photo or a screen replay is the obvious attack against any face-only system, so every register/login capture is checked two different ways before the embedding is ever compared:

- **Active** (`src/services/auth/face-liveness.service.ts`) — the server issues a randomized, signed, single-use challenge (2 or 3 of: turn left, turn right, look down) and requires the client to demonstrably perform it — real head-pose tracked frame-by-frame, inter-frame pixel motion above a static-photo floor, and a minimum capture duration. Replaying the same captured evidence against a reused token is rejected server-side (`SecurityEvent` audit trail).
- **Passive** (`src/services/auth/minifasnet-pad.service.ts`) — a texture-based presentation-attack model (MiniFASNet, two models fused) scored on a color crop of the face, independent of pose or motion. This catches a well-lit screen/print replay that happens to satisfy the active check's motion requirement.

Either check failing denies the attempt. Neither is a certified PAD system (no IR/depth sensor, RGB webcam only) — see the comments in `face-liveness.service.ts` for exactly what this does and doesn't defend against.

## Matching

- Embeddings: `face-api.js` (128-d), computed in the browser. The code has a slot for a licensed ArcFace-family engine (`BIOMETRIC_RECOGNITION_ENGINE=arcface-family-licensed`) that fails closed until real weights are installed — not wired up yet.
- 1:N identify and 1:1 claimed-login both require the matched account to be the clear best match across the *entire* enrolled gallery, not just under a threshold — a close second candidate (e.g. a look-alike) refuses the match instead of guessing. Near-duplicate registrations (same face range as an existing different account, but not close enough to hard-block) are logged for review, not silently allowed through unnoticed.
- Templates are AES-256-GCM encrypted at rest (`biometric-crypto.service.ts`) and only ever decrypted server-side for a comparison.

## Stack

| Component | Technology |
|---|---|
| Frontend | React + Vite + react-router, `client/` |
| Backend | Node 20 + TypeScript + Express, `src/` |
| Face embedding (client) | face-api.js (MIT) |
| Passive liveness (server) | MiniFASNet v2 + v1SE, ONNX via `onnxruntime-node` |
| Database | PostgreSQL + Prisma |
| Auth | JWT access token + HttpOnly refresh cookie, rate-limited |

## Project structure

```
client/src/
  pages/auth/          — PinitGateway, LoginFlow, RegistrationFlow
  pages/WelcomeHello.tsx
  components/auth/     — FaceRoundScan, CameraStage, AuthShell
  lib/                 — face-capture.ts, face-liveness.ts, face-api-client.ts, auth.ts
  router.tsx            — exactly /login, /register, /welcome, 404

src/
  app.ts, server.ts
  api/routes/auth.routes.ts
  api/controllers/{auth,face-auth,health}.controller.ts
  services/auth/
    biometric-auth.service.ts      — register / login / identify orchestration
    biometric-matching.service.ts  — distance, margin, duplicate/identify rules
    biometric-crypto.service.ts    — AES-256-GCM template encryption
    face-liveness.service.ts       — active (pose challenge) liveness
    minifasnet-pad.service.ts      — passive (texture) liveness
    recognition-engine.ts, face-gallery.ts, face-auth-machine.ts, ...

models/
  minifasnet_v2_2.7_80x80.onnx
  minifasnet_v1se_4.0_80x80.onnx

prisma/schema.prisma   — full schema kept as-is; only User, BiometricIdentity,
                         FaceTemplate, RefreshToken, UserSession, UserDevice,
                         SecurityEvent, LoginHistory are actually used
```

## API surface

All under `API_PREFIX` (default `/api/v1`), router: `src/api/routes/auth.routes.ts`.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/auth/face/challenge` | Issue a signed, single-use liveness challenge |
| `POST` | `/auth/face/enroll/begin` | Reserve a Pinit ID ahead of registration |
| `POST` | `/auth/face/register` | Submit face samples + liveness evidence → create account |
| `POST` | `/auth/face/login` | 1:1 sign-in against a claimed Pinit ID |
| `POST` | `/auth/face/identify` | 1:N sign-in, face only, no ID supplied |
| `GET` | `/auth/face/status` | Whether the signed-in user has completed face registration |
| `POST` | `/auth/refresh` | Rotate access token from the refresh cookie |
| `POST` | `/auth/logout` | Revoke the refresh token |
| `GET` | `/auth/me` | Current signed-in user (backs the Welcome page) |
| `GET` | `/health`, `/api/v1/ping` | Liveness/health checks (unauthenticated) |

## Setup & run

### Prerequisites
- Node.js 20+
- Docker (for the dev Postgres) or any Postgres 16 instance

### 1. Install
```bash
npm install
cd client && npm install && cd ..
```

### 2. Environment
```bash
cp .env.example .env
```
Set at minimum: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` (a real random value — not in `.env.example`, falls back to an insecure default otherwise), `BIOMETRIC_ENCRYPTION_KEY`, `ALLOWED_ORIGIN`/`ALLOWED_ORIGINS` for CORS. Everything else in `.env.example` belongs to removed features — ignore it.

### 3. Database
```bash
docker compose -f docker-compose.dev.yml up -d   # local dev Postgres on :5435
npx prisma migrate deploy
```

### 4. Run
```bash
npm run dev:backend        # http://localhost:4000
cd client && npm run dev   # http://localhost:3002
```
Face capture needs camera access, which browsers only grant over HTTPS or `localhost` — keep that in mind for whatever host you deploy to.

### Build / production
```bash
npm run build          # backend -> dist/
cd client && npm run build   # frontend -> client/dist/ (served directly by the backend if present)
npm start               # node dist/server.js
```
`Dockerfile` builds the backend (including `models/`) as a single image; the frontend build is a separate deploy target or can be served by the same process from `client/dist/`.

## License

This project is a research prototype.

### Third-party models

- `models/minifasnet_v2_2.7_80x80.onnx` and `models/minifasnet_v1se_4.0_80x80.onnx` — passive (silent) face anti-spoofing, from [minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) (Apache-2.0), official weights converted to ONNX. Used by `src/services/auth/minifasnet-pad.service.ts`.
- `face-api.js` (MIT) — client-side face detection and embedding, `client/public/models/`.
