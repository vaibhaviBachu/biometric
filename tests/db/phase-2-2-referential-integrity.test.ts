/**
 * Phase 2.2 (DB-GAP-10, DB-GAP-11, DB-GAP-12, DB-GAP-13) — referential
 * integrity against a real, full-schema local PostgreSQL. Nothing here is
 * mocked: these are genuine database constraint checks.
 *
 * Run with (after `docker compose -f docker-compose.dev.yml up -d`):
 *   PHASE_2_2_TEST_DATABASE_URL=postgresql://pinit:pinit@localhost:5435/pinit_hub npx jest tests/db/phase-2-2-referential-integrity.test.ts
 */
import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, describeWithDb } from './phase-2-2-test-env';

describeWithDb('Phase 2.2 referential integrity (local PostgreSQL)', () => {
  let db: PrismaClient;
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `p22-user-${suffix}`;
  const orgId = `p22-org-${suffix}`;
  const subId = `p22-sub-${suffix}`;
  let billingId: string;
  let auditLogId: string;

  beforeAll(async () => {
    db = createTestDb();
    await db.user.create({
      data: { id: userId, shortId: `P22${suffix}`, email: `p22-${suffix}@test.local`, passwordHash: 'x' },
    });
    await db.organization.create({
      data: { id: orgId, ownerUserId: userId, name: `P22 Org ${suffix}`, shortId: `p22org${suffix}` },
    });
    await db.subscription.create({
      data: { id: subId, userId, planId: 'plan_free', status: 'ACTIVE' },
    });
    const bh = await db.billingHistory.create({
      data: { subscriptionId: subId, amountCents: 999, currency: 'USD' },
    });
    billingId = bh.id;
    const al = await db.organizationAuditLog.create({
      data: { organizationId: orgId, action: 'TEST_ACTION', title: 'Phase 2.2 test entry' },
    });
    auditLogId = al.id;
  });

  afterAll(async () => {
    // Children first — Restrict means the parent cannot go until these are gone.
    await db.billingHistory.delete({ where: { id: billingId } }).catch(() => {});
    await db.organizationAuditLog.delete({ where: { id: auditLogId } }).catch(() => {});
    await db.subscription.delete({ where: { id: subId } }).catch(() => {});
    await db.organization.delete({ where: { id: orgId } }).catch(() => {});
    await db.user.delete({ where: { id: userId } }).catch(() => {});
    await db.$disconnect();
  });

  test('DB-GAP-10: deleting a Subscription with BillingHistory rows is blocked, not silently cascaded', async () => {
    await expect(db.subscription.delete({ where: { id: subId } })).rejects.toThrow();
    // The billing record must still exist afterward — nothing was destroyed.
    const stillThere = await db.billingHistory.findUnique({ where: { id: billingId } });
    expect(stillThere).not.toBeNull();
  });

  test('DB-GAP-11: deleting an Organization with audit-log rows is blocked, not silently cascaded', async () => {
    await expect(db.organization.delete({ where: { id: orgId } })).rejects.toThrow();
    const stillThere = await db.organizationAuditLog.findUnique({ where: { id: auditLogId } });
    expect(stillThere).not.toBeNull();
  });

  test('DB-GAP-12: PlatformEvent dedupeKey is unique per owner, not globally', async () => {
    const dedupeKey = `p22-dedupe-${suffix}`;
    const base = {
      name: 'test.event', category: 'test', severity: 'info',
      entityType: 'test', entityId: 'x', title: 't', body: 'b', dedupeKey,
    };
    const first = await db.platformEvent.create({ data: { ...base, ownerUserId: userId } });

    // Same owner, same dedupeKey -> rejected.
    await expect(db.platformEvent.create({ data: { ...base, ownerUserId: userId } })).rejects.toThrow();

    // Different owner, same dedupeKey -> allowed (per-owner scoping, not global).
    const otherUserId = `p22-user-b-${suffix}`;
    await db.user.create({ data: { id: otherUserId, shortId: `P22B${suffix}`, email: `p22b-${suffix}@test.local`, passwordHash: 'x' } });
    const second = await db.platformEvent.create({ data: { ...base, ownerUserId: otherUserId } });

    await db.platformEvent.delete({ where: { id: first.id } });
    await db.platformEvent.delete({ where: { id: second.id } });
    await db.user.delete({ where: { id: otherUserId } });
  });

  test('DB-GAP-13: Notification dedupeKey is unique per user, not globally', async () => {
    const dedupeKey = `p22-notif-dedupe-${suffix}`;
    const base = { type: 'test', title: 't', body: 'b', dedupeKey };
    const first = await db.notification.create({ data: { ...base, userId } });

    await expect(db.notification.create({ data: { ...base, userId } })).rejects.toThrow();

    await db.notification.delete({ where: { id: first.id } });
  });
});
