/**
 * The owner's share list must only turn a link back on when it was switched off automatically.
 * Before the fix it re-enabled every inactive link with forwards, including links the owner revoked.
 * Prisma is mocked: nothing here touches a database.
 */
const db = {
  shareLink: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  platformEvent: { findMany: jest.fn() },
  shareAccessLog: { findFirst: jest.fn() },
  vaultRecord: { findMany: jest.fn() },
};
jest.mock('../../src/lib/prisma', () => ({ prisma: db }));
jest.mock('../../src/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));
const emit = jest.fn();
jest.mock('../../src/services/platform-events/platform-event.engine', () => ({ platformEvents: { emit } }));

import { healDecision, loadDeactivationEvidence } from '../../src/services/share/share-link-heal';
import { shareLinkService } from '../../src/services/share/share-link.service';
import { emitShareLinkRevoked } from '../../src/services/platform-events/share-events';

const PARENT = { oneTimeUse: false, linkType: 'PARENT' };
const at = new Date('2026-10-12T15:37:46Z');

describe('healDecision', () => {
  it('never heals without a record of why the link was switched off', () => {
    expect(healDecision(PARENT, null).heal).toBe(false);
  });

  it('keeps an owner revoke off', () => {
    expect(healDecision(PARENT, { name: 'share.link.revoked', createdAt: at, reason: 'owner' }).heal).toBe(false);
  });

  it('heals an automatic risk revoke', () => {
    expect(healDecision(PARENT, { name: 'share.link.revoked', createdAt: at, reason: 'auto_risk' }).heal).toBe(true);
  });

  it('legacy revoke (no reason): heals only with a CRITICAL viewer access at the same moment', () => {
    expect(healDecision(PARENT, { name: 'share.link.revoked', createdAt: at, criticalViewerAccessNearby: true }).heal).toBe(true);
    expect(healDecision(PARENT, { name: 'share.link.revoked', createdAt: at, criticalViewerAccessNearby: false }).heal).toBe(false);
    expect(healDecision(PARENT, { name: 'share.link.revoked', createdAt: at }).heal).toBe(false);
  });

  it('one-time use: only a one-time PARENT (forwarding hub) is reopened', () => {
    const consumed = { name: 'share.link.one_time_consumed' as const, createdAt: at };
    expect(healDecision({ oneTimeUse: true, linkType: 'PARENT' }, consumed).heal).toBe(true);
    expect(healDecision({ oneTimeUse: true, linkType: 'CHILD' }, consumed).heal).toBe(false);
  });
});

describe('loadDeactivationEvidence', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the LATEST event: an owner revoke after an automatic one keeps the link off', async () => {
    db.platformEvent.findMany.mockResolvedValue([ // newest first, as queried
      { entityId: 'L1', name: 'share.link.revoked', createdAt: new Date('2026-10-14'), payload: { reason: 'owner' } },
      { entityId: 'L1', name: 'share.link.revoked', createdAt: new Date('2026-10-12'), payload: { reason: 'auto_risk' } },
    ]);
    const ev = await loadDeactivationEvidence(['L1']);
    expect(ev.get('L1')?.reason).toBe('owner');
    expect(healDecision(PARENT, ev.get('L1')!).heal).toBe(false);
  });

  it('checks for a CRITICAL viewer access only for legacy revokes without a reason', async () => {
    db.platformEvent.findMany.mockResolvedValue([
      { entityId: 'L2', name: 'share.link.revoked', createdAt: at, payload: null },
    ]);
    db.shareAccessLog.findFirst.mockResolvedValue({ id: 'log' });
    const ev = await loadDeactivationEvidence(['L2']);
    expect(ev.get('L2')?.criticalViewerAccessNearby).toBe(true);
    expect(db.shareAccessLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ shareLinkId: 'L2', riskLevel: 'CRITICAL' }),
    }));
  });
});

describe('share list (listAll) self-heal', () => {
  const base = {
    linkType: 'PARENT', isActive: false, expiresAt: null, maxViews: null, viewCount: 0, oneTimeUse: false,
    createdAt: new Date('2026-10-10'), token: 't', vaultId: 'vault-1', _count: { accessLogs: 0, childLinks: 3 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(shareLinkService as unknown as { attachListActivityStats: (l: unknown) => unknown }, 'attachListActivityStats')
      .mockImplementation(async (l: unknown) => l);
    db.shareLink.update.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, isActive: true }));
    db.vaultRecord.findMany.mockResolvedValue([{ id: 'vault-1' }]);
    db.shareAccessLog.findFirst.mockResolvedValue(null);
  });

  it('keeps an owner-revoked link with forwards OFF, and heals only the automatically revoked one', async () => {
    db.shareLink.findMany.mockResolvedValue([
      { ...base, id: 'owner-revoked' },
      { ...base, id: 'auto-revoked' },
      { ...base, id: 'no-record' },
    ]);
    db.platformEvent.findMany.mockResolvedValue([
      { entityId: 'owner-revoked', name: 'share.link.revoked', createdAt: at, payload: { reason: 'owner' } },
      { entityId: 'auto-revoked', name: 'share.link.revoked', createdAt: at, payload: { reason: 'auto_risk' } },
    ]);

    const list = await shareLinkService.listAll('owner-1') as Array<{ id: string; isActive: boolean }>;

    expect(db.shareLink.update).toHaveBeenCalledTimes(1);
    expect(db.shareLink.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'auto-revoked' } }));
    expect(list.find((l) => l.id === 'owner-revoked')?.isActive).toBe(false);
    expect(list.find((l) => l.id === 'no-record')?.isActive).toBe(false);
    expect(list.find((l) => l.id === 'auto-revoked')?.isActive).toBe(true);
  });

  it('never heals a link whose file was removed', async () => {
    db.shareLink.findMany.mockResolvedValue([{ ...base, id: 'auto-revoked' }]);
    db.platformEvent.findMany.mockResolvedValue([
      { entityId: 'auto-revoked', name: 'share.link.revoked', createdAt: at, payload: { reason: 'auto_risk' } },
    ]);
    db.vaultRecord.findMany.mockResolvedValue([]);
    await shareLinkService.listAll('owner-1');
    expect(db.shareLink.update).not.toHaveBeenCalled();
  });
});

describe('revoke events record their reason', () => {
  it('stores the reason in the event payload', () => {
    emitShareLinkRevoked('owner-1', 'L1', 'tok', 'file.jpg', { reason: 'owner' });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ payload: { reason: 'owner' } }));
  });
});
