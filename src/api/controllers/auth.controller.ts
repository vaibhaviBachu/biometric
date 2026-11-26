import type { Request, Response } from 'express';
import { authService } from '../../services/auth/auth.service';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../../lib/auth-cookies';
import { prisma } from '../../lib/prisma';

export const authController = {
  async refresh(req: Request, res: Response) {
    const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    const refreshToken = (typeof bodyToken === 'string' && bodyToken.trim()) || readRefreshCookie(req);
    if (!refreshToken) { res.status(400).json({ success: false, error: 'refreshToken required' }); return; }
    try {
      const tokens = await authService.refresh(refreshToken);
      setRefreshCookie(req, res, tokens.refreshToken);
      // A caller that sent its refresh token in the body (the browser extension) cannot read the cookie, and the old
      // token was just rotated away, so it gets the new pair back in the body. Cookie callers never see the refresh token.
      const bodyCaller = typeof bodyToken === 'string' && bodyToken.trim() === refreshToken;
      res.json({
        success: true,
        data: { accessToken: tokens.accessToken },
        ...(bodyCaller ? { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } : {}),
      });
    } catch {
      clearRefreshCookie(req, res);
      res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
    }
  },

  async logout(req: Request, res: Response) {
    const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    const refreshToken = (typeof bodyToken === 'string' && bodyToken.trim()) || readRefreshCookie(req);
    if (refreshToken) await authService.logout(refreshToken);
    clearRefreshCookie(req, res);
    res.json({ success: true });
  },

  async me(req: Request, res: Response) {
    const payload = (req as { user?: {
      sub?: string;
      shortId?: string;
      name?: string;
      role?: string;
      accountType?: string;
      lastActiveShell?: 'PERSONAL' | 'BUSINESS';
    } }).user;
    if (!payload?.sub) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    try {
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          shortId: true,
          fullName: true,
          role: true,
          isActive: true,
          accountType: true,
          lastActiveShell: true,
          ownedOrganization: { select: { id: true, setupCompletedAt: true } },
        },
      });
      if (!user || !user.isActive) {
        res.status(401).json({ success: false, error: 'Session is no longer valid' });
        return;
      }
      const accountType = user.accountType === 'BUSINESS' ? 'BUSINESS' : 'INDIVIDUAL';
      const lastActiveShell = user.lastActiveShell === 'BUSINESS' ? 'BUSINESS' : 'PERSONAL';
      res.json({
        success: true,
        data: {
          sub: user.id,
          shortId: user.shortId,
          name: user.fullName,
          role: user.role,
          accountType,
          lastActiveShell,
          capabilities: {
            buyer_enabled: true,
            can_purchase: true,
            business: accountType === 'BUSINESS',
            business_setup_complete: Boolean(user.ownedOrganization?.setupCompletedAt),
          },
        },
      });
    } catch {
      res.json({
        success: true,
        data: {
          ...payload,
          lastActiveShell: payload.lastActiveShell === 'BUSINESS' ? 'BUSINESS' : 'PERSONAL',
          capabilities: {
            buyer_enabled: true,
            can_purchase: true,
            business: payload.accountType === 'BUSINESS',
          },
        },
      });
    }
  },
};
