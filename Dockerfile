# PINIT backend — multi-stage build, for Render/any container host.
#
# Builds only the API server. The Vercel-hosted frontend (client/) is a
# separate deploy target and is not baked into this image.
#
# `prisma migrate deploy` runs on every container boot (see CMD below), not as
# a separate manual/Shell step — Render's free compute plan has no Shell/SSH
# access at all, so a step that has to be run by hand would never actually run.
# `migrate deploy` only applies pending migrations (no-op if none) and takes
# its own advisory lock, so it's safe even if this ever scales to >1 instance.

FROM node:20-slim AS builder
WORKDIR /app

# Toolchain some npm packages fall back to at install time if no prebuilt
# native binary matches this platform (defensive; sharp/ffmpeg-static/
# @ffprobe-installer normally ship prebuilt binaries and won't need this).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# MiniFASNet passive-PAD weights (minifasnet-pad.service.ts) — without these the passive
# liveness check fails closed (never silently skipped), denying real registrations/logins.
COPY models ./models

# Drop devDependencies from the already-installed, already-`prisma generate`d
# node_modules instead of a second install in the runtime stage — keeps the
# generated Prisma client without regenerating it.
RUN npm prune --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/false pinit

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/models ./models
COPY package.json ./

# ./vault/encrypted is only used when Supabase/S3 storage is not configured
# (local-dev fallback path); ./tmp/uploads is genuinely used in every
# environment as request-scoped multer temp storage.
RUN mkdir -p ./vault/encrypted ./tmp/uploads && chown -R pinit:pinit /app
USER pinit

EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
