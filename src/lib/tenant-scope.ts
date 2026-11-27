/**
 * Authorization identity — independent of how the user logged in.
 *
 * Face + liveness is an authentication factor only. It mints a JWT; it is
 * never re-used as resource ownership.
 *
 * Never trust userId from req.body / query / params.
 */
import { Request } from 'express';
import { AppError } from '../api/middleware/error.middleware';

/** Client fields that must never be the authorization source. */
export const CLIENT_OWNER_KEYS = [
  'userId',
  'user_id',
  'ownerId',
  'owner_id',
  'ownerUserId',
  'owner_user_id',
  'tenantId',
  'tenant_id',
] as const;

/** JWT.sub — the only authorization principal. */
export function getAuthUserId(req: Request): string {
  const userId = (req as { user?: { sub?: string } }).user?.sub;
  if (!userId) throw new AppError(401, 'Unauthorized');
  return userId;
}

export function isPrivilegedAdminRole(role?: string | null): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

/**
 * Drop client-supplied owner/user/tenant ids so they cannot override JWT sub.
 * Privileged admins keep these fields for explicit cross-user admin routes.
 */
export function stripClientOwnerIdentity(req: Request): void {
  const role = (req as { user?: { role?: string } }).user?.role;
  if (isPrivilegedAdminRole(role)) return;

  const strip = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    const rec = obj as Record<string, unknown>;
    for (const key of CLIENT_OWNER_KEYS) {
      if (Object.prototype.hasOwnProperty.call(rec, key)) delete rec[key];
    }
  };

  strip(req.body);
  strip(req.query);
  strip(req.params);
}
