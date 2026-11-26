/**
 * Every notification an emitter can produce reaches the bell, or deliberately does not.
 *
 * Before this, no Personal event had a class, so none could reach the bell (the bell counts NOTIFICATION and ALERT rows only).
 * These tests read the emitters' own source, so a new notification type that nobody classified fails here instead of being
 * silently hidden or silently flooding the bell.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const created: Array<Record<string, unknown>> = [];
const notify = jest.fn(async () => undefined);

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    user: { findUnique: jest.fn(async () => ({ notifyInvestigation: true, notifyShareAccess: true, notifyRiskAlerts: true, notifySecurity: true, notifyVault: true, notifyDna: true, notifyCertificates: true, notifyMonitoring: true, notifyAutomation: true, notifyReports: true, notifySystem: true, notifyUpdates: true })) },
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data; }),
      update: jest.fn(),
    },
  },
}));
jest.mock('../../src/services/platform-events/realtime-hub', () => ({ realtimeHub: { notify: (...a: unknown[]) => (notify as unknown as (...x: unknown[]) => unknown)(...a) } }));

import { classForNotificationType, CLASSIFIED_NOTIFICATION_TYPES, isBellType } from '../../src/services/platform-events/notification-classes';
import { handleNotificationSubscriber } from '../../src/services/platform-events/notification-subscriber';
import { describeTraceFinal, finalTraceDedupeKey, traceDeepLink } from '../../src/services/platform-events/trace-events';
import { BELL_NOTIFICATION_CLASS_WHERE } from '../../src/services/platform-events/notification-policy';

const SRC = path.resolve(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every `notificationType: 'X'` any emitter writes. */
function emittedTypes(): string[] {
  const found = new Set<string>();
  for (const f of walk(SRC)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/notificationType:\s*['"]([A-Z_]+)['"]/g)) found.add(m[1]!);
  }
  return [...found].sort();
}

// Types that are deliberately left to the default (ACTIVITY): none today. A type must be listed in the table on purpose.
const LEFT_TO_DEFAULT: string[] = [];

describe('the type table', () => {
  test('every notification type an emitter writes is classified on purpose', () => {
    const missing = emittedTypes().filter((t) => !CLASSIFIED_NOTIFICATION_TYPES.includes(t) && !LEFT_TO_DEFAULT.includes(t));
    expect(missing).toEqual([]);
  });

  test('the agreed decisions', () => {
    for (const t of ['LINK_VIEWED', 'CERT_GENERATED', 'LINK_EXPIRED', 'VAULT_DELETED', 'INVESTIGATION_STARTED', 'DNA_GENERATED', 'VAULT_STORED']) {
      expect(classForNotificationType(t)).toBe('ACTIVITY');
    }
    for (const t of ['INVESTIGATION_COMPLETED', 'INVESTIGATION_FAILED', 'INVESTIGATION_INCONCLUSIVE', 'LINK_DOWNLOADED', 'FORWARD_DETECTED']) {
      expect(classForNotificationType(t)).toBe('NOTIFICATION');
    }
    for (const t of ['SCREENSHOT_ATTEMPT', 'GPS_IP_MISMATCH', 'GEO_BLOCKED', 'AI_TAMPERING_DETECTED', 'DUPLICATE_UPLOAD_ATTEMPT', 'VAULT_ENCRYPTION_FAILED', 'NEW_DEVICE']) {
      expect(classForNotificationType(t)).toBe('ALERT');
    }
  });

  test('an unclassified type is ACTIVITY: history only, never badged', () => {
    expect(classForNotificationType('SOMETHING_NEW')).toBe('ACTIVITY');
    expect(isBellType('SOMETHING_NEW')).toBe(false);
    expect(classForNotificationType(undefined)).toBe('ACTIVITY');
  });

  test('no type is listed under two classes', () => {
    const table = JSON.parse(fs.readFileSync(path.join(SRC, 'services/platform-events/notification-class-table.json'), 'utf8')) as Record<string, string[]>;
    const all = [...table['ALERT']!, ...table['NOTIFICATION']!, ...table['ACTIVITY']!];
    expect(new Set(all).size).toBe(all.length);
  });

  test('the backfill script uses the same table', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { classFor } = require('../../scripts/backfill-notification-class.cjs') as { classFor: (t: string) => string };
    for (const t of [...CLASSIFIED_NOTIFICATION_TYPES, 'UNKNOWN_TYPE']) expect(classFor(t)).toBe(classForNotificationType(t));
  });
});

describe('what the bell counts', () => {
  test('the bell query is NOTIFICATION and ALERT, and exactly the bell types match it', () => {
    expect(BELL_NOTIFICATION_CLASS_WHERE).toEqual({
      OR: [
        { notificationClass: { in: ['NOTIFICATION', 'ALERT'] } },
        { notificationClass: null, type: { in: CLASSIFIED_NOTIFICATION_TYPES.filter((t) => isBellType(t)) } },
      ],
    });
    for (const t of emittedTypes()) {
      const inBell = ['NOTIFICATION', 'ALERT'].includes(classForNotificationType(t));
      expect(isBellType(t)).toBe(inBell);
    }
  });
});

describe('the subscriber writes the class', () => {
  beforeEach(() => { created.length = 0; notify.mockClear(); });

  const base = { category: 'sharing' as const, severity: 'info' as const, ownerUserId: 'u1', entityType: 'vault', entityId: 'v1', title: 't', body: 'b' };

  test('a bell event is stored with its class and wakes the live stream', async () => {
    await handleNotificationSubscriber({ ...base, name: 'share.link.downloaded', notificationType: 'LINK_DOWNLOADED' });
    expect(created).toHaveLength(1);
    expect(created[0]!['notificationClass']).toBe('NOTIFICATION');
    expect(notify).toHaveBeenCalledWith('u1');
  });

  test('an activity event is kept in history with the ACTIVITY class (so the bell ignores it)', async () => {
    await handleNotificationSubscriber({ ...base, name: 'share.link.viewed', notificationType: 'LINK_VIEWED' });
    expect(created[0]!['notificationClass']).toBe('ACTIVITY');
  });

  test('an alert is stored as ALERT', async () => {
    await handleNotificationSubscriber({ ...base, category: 'security', name: 'share.security.screenshot_attempt', notificationType: 'SCREENSHOT_ATTEMPT' });
    expect(created[0]!['notificationClass']).toBe('ALERT');
  });
});

describe('the Trace notifications', () => {
  const p = { ownerUserId: 'u1', investigationId: 'inv-1', caseId: 'case-1', fileName: 'copy.jpg' };

  test('each outcome has its own honest wording and type', () => {
    const done = describeTraceFinal({ ...p, outcome: 'COMPLETED', verdictLabel: 'Possible match', evidenceCode: 'EVD-0049' });
    expect(done.type).toBe('INVESTIGATION_COMPLETED');
    expect(done.body).toContain('Possible match');
    expect(done.body).toContain('EVD-0049');

    const none = describeTraceFinal({ ...p, outcome: 'COMPLETED', verdictLabel: 'No match found', evidenceCode: null, evidenceSaved: false });
    expect(none.body).toContain('No match found');
    expect(none.body).toContain('could not be added to Evidence');

    const inc = describeTraceFinal({ ...p, outcome: 'INCONCLUSIVE' });
    expect(inc.type).toBe('INVESTIGATION_INCONCLUSIVE');
    expect(inc.body).toMatch(/not a "no match"/);

    const failed = describeTraceFinal({ ...p, outcome: 'FAILED' });
    expect(failed.type).toBe('INVESTIGATION_FAILED');
  });

  test('a failure never carries raw error text unless the caller passes a safe sentence', () => {
    const failed = describeTraceFinal({ ...p, outcome: 'FAILED' });
    expect(failed.body).not.toMatch(/prisma|stack|ECONN|SELECT|at \w+\.\w+/i);
  });

  test('the deep link opens the investigation record, and every outcome shares one dedupe key', () => {
    expect(traceDeepLink('case-1')).toBe('/pinit-hub/investigation?case=case-1');
    expect(finalTraceDedupeKey('inv-1')).toBe('inv_final:inv-1');
  });

  test('a second final notification for the same investigation is dropped', async () => {
    const prismaMod = jest.requireMock('../../src/lib/prisma') as { prisma: { notification: { findFirst: jest.Mock } } };
    created.length = 0;
    const event = { name: 'investigation.completed', category: 'investigation' as const, severity: 'info' as const, ownerUserId: 'u1', entityType: 'trace_investigation', entityId: 'case-1', title: 'Trace finished', body: 'x', notificationType: 'INVESTIGATION_COMPLETED', dedupeKey: finalTraceDedupeKey('inv-1') };
    prismaMod.prisma.notification.findFirst.mockResolvedValueOnce(null as never);
    await handleNotificationSubscriber(event);
    expect(created).toHaveLength(1);
    prismaMod.prisma.notification.findFirst.mockResolvedValueOnce({ id: 'existing' } as never);
    await handleNotificationSubscriber({ ...event, notificationType: 'INVESTIGATION_FAILED', name: 'investigation.failed' });
    expect(created).toHaveLength(1); // the failed notice for the same investigation was dropped
  });
});
