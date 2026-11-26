import type { Request, Response } from 'express';
import { getHealthReport } from '../../lib/health';

function statusCodeFor(status: 'healthy' | 'degraded' | 'unhealthy'): number {
  return status === 'healthy' ? 200 : status === 'degraded' ? 207 : 503;
}

/**
 * Public health: the status code (what platform health gates and the sidebar read) plus the verdict, nothing else.
 * Versions, uptime, the storage backend, memory figures and database error text help an attacker map the system,
 * so the full report is only available to signed-in admins (detailedHealth).
 */
export async function publicHealth(_req: Request, res: Response): Promise<void> {
  const report = await getHealthReport();
  res.status(statusCodeFor(report.status)).json({ status: report.status, timestamp: report.timestamp });
}

export async function detailedHealth(_req: Request, res: Response): Promise<void> {
  const report = await getHealthReport();
  res.status(statusCodeFor(report.status)).json(report);
}
