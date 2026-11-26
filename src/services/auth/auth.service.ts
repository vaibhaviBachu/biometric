import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma';
import { config } from '../../config/index';

const ACCESS_EXPIRES  = config.jwt.accessTtl as jwt.SignOptions['expiresIn'];
const REFRESH_EXPIRES = '30d';
const REFRESH_MS      = 30 * 24 * 60 * 60 * 1000;
/**
 * A refresh token that was just rotated keeps working this long. Without it, a reply the browser never stores (the
 * page reloaded mid-request, so the new cookie is dropped) or two tabs refreshing together leave the browser holding
 * a token the server already deleted, and the next reload signs the user out. Logout and revocation still delete
 * the row at once.
 */
export const REFRESH_ROTATION_GRACE_MS = 60_000;

export interface JwtPayload {
  sub: string;
  shortId: string;
  name: string;
  role: string;
  accountType?: string;
  lastActiveShell?: 'PERSONAL' | 'BUSINESS';
  iat?: number;
  exp?: number;
}

type UserRow = {
  id: string;
  shortId: string;
  fullName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  accountType?: string | null;
  lastActiveShell?: 'PERSONAL' | 'BUSINESS' | null;
};

function generateShortId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'PINIT-';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function signAccess(p: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(p, config.jwt.secret, { expiresIn: ACCESS_EXPIRES });
}
// Only HS256 is ever issued; naming it on verify means a token claiming another algorithm (or "none") is refused.
const JWT_ALGORITHMS: jwt.Algorithm[] = ['HS256'];

// A unique id per refresh token: two tokens issued in the same second for the same user were otherwise identical
// strings and collided on the unique column.
function signRefresh(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwt.secret, { expiresIn: REFRESH_EXPIRES, jwtid: randomUUID() });
}

async function findByShortId(shortId: string): Promise<UserRow | null> {
  const rows = await (prisma as any).$queryRaw`
    SELECT id, "shortId", "fullName", role, "isActive", "lastLoginAt"
    FROM users WHERE "shortId" = ${shortId} LIMIT 1
  `;
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function createUser(shortId: string): Promise<UserRow> {
  const rows = await (prisma as any).$queryRaw`
    INSERT INTO users (id, "shortId", "fullName", role, "isActive", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${shortId}, 'PINIT User', 'USER', true, now(), now())
    RETURNING id, "shortId", "fullName", role, "isActive", "lastLoginAt"
  `;
  return rows[0];
}

async function touchLogin(id: string) {
  await (prisma as any).$executeRaw`UPDATE users SET "lastLoginAt" = now(), "updatedAt" = now() WHERE id = ${id}`;
}

function tokenFor(user: UserRow) {
  const access  = signAccess({
    sub: user.id,
    shortId: user.shortId,
    name: user.fullName,
    role: user.role,
    accountType: user.accountType === 'BUSINESS' ? 'BUSINESS' : 'INDIVIDUAL',
    lastActiveShell: user.lastActiveShell === 'BUSINESS' ? 'BUSINESS' : 'PERSONAL',
  });
  const refresh = signRefresh(user.id);
  return { access, refresh };
}

export const authService = {
  async createAccount() {
    let shortId = generateShortId();
    let attempts = 0;
    while (await findByShortId(shortId)) {
      shortId = generateShortId();
      if (++attempts > 10) throw new Error('ID_GENERATION_FAILED');
    }

    const user = await createUser(shortId);
    const { access, refresh } = tokenFor(user);

    await prisma.refreshToken.create({
      data: { token: refresh, userId: user.id, expiresAt: new Date(Date.now() + REFRESH_MS) },
    });

    return { user: { id: user.id, shortId: user.shortId, name: user.fullName, role: user.role }, accessToken: access, refreshToken: refresh };
  },

  async loginWithId(shortId: string) {
    const user = await findByShortId(shortId.toUpperCase().trim());
    if (!user || !user.isActive) throw new Error('INVALID_ID');

    await touchLogin(user.id);
    const { access, refresh } = tokenFor(user);

    await prisma.refreshToken.create({
      data: { token: refresh, userId: user.id, expiresAt: new Date(Date.now() + REFRESH_MS) },
    });

    return { user: { id: user.id, shortId: user.shortId, name: user.fullName, role: user.role }, accessToken: access, refreshToken: refresh };
  },

  async refresh(token: string) {
    // The signature and expiry are checked first, so a value that was never issued by this server, or has
    // expired, is refused before the database is asked. (Issuer/audience are not part of the tokens issued so
    // far; adding them would invalidate every existing session, so they are deliberately not required.)
    let claims: { sub?: unknown };
    try {
      claims = jwt.verify(token, config.jwt.secret, { algorithms: JWT_ALGORITHMS }) as { sub?: unknown };
    } catch {
      throw new Error('INVALID_REFRESH');
    }

    const stored = await prisma.refreshToken.findUnique({ where: { token } });
    if (!stored || stored.expiresAt < new Date()) throw new Error('INVALID_REFRESH');
    // The token must belong to the user it was stored for (revocation lives in this table: logout, the
    // "sign out everywhere" actions and super-admin session revoke all delete the rows).
    if (claims.sub !== stored.userId) throw new Error('INVALID_REFRESH');

    const user = await prisma.user.findUnique({
      where: { id: stored.userId },
      select: {
        id: true,
        shortId: true,
        fullName: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        accountType: true,
        lastActiveShell: true,
      },
    });
    if (!user || !user.isActive) throw new Error('INVALID_REFRESH');

    // Shorten the used token to the grace window (only ever shortened, never extended), and drop this user's rows
    // whose time is already up.
    const graceUntil = new Date(Date.now() + REFRESH_ROTATION_GRACE_MS);
    await prisma.refreshToken.updateMany({ where: { token, expiresAt: { gt: graceUntil } }, data: { expiresAt: graceUntil } });
    await prisma.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });
    const { access, refresh } = tokenFor(user);

    await prisma.refreshToken.create({
      data: { token: refresh, userId: user.id, expiresAt: new Date(Date.now() + REFRESH_MS) },
    });

    return { accessToken: access, refreshToken: refresh };
  },

  async logout(token: string) {
    await prisma.refreshToken.deleteMany({ where: { token } });
  },

  verifyAccess(token: string): JwtPayload {
    return jwt.verify(token, config.jwt.secret, { algorithms: JWT_ALGORITHMS }) as JwtPayload;
  },

  /** Issue access+refresh for an already-authenticated user (extension OAuth). */
  async issueSessionTokens(user: {
    id: string;
    shortId: string;
    fullName: string;
    role: string;
    accountType?: string;
    lastActiveShell?: 'PERSONAL' | 'BUSINESS';
  }): Promise<{ accessToken: string; refreshToken: string }> {
    const row: UserRow = {
      id: user.id,
      shortId: user.shortId,
      fullName: user.fullName,
      role: user.role,
      isActive: true,
      lastLoginAt: null,
      accountType: user.accountType,
      lastActiveShell: user.lastActiveShell,
    };
    const { access, refresh } = tokenFor(row);
    await prisma.refreshToken.create({
      data: { token: refresh, userId: user.id, expiresAt: new Date(Date.now() + REFRESH_MS) },
    });
    return { accessToken: access, refreshToken: refresh };
  },
};
