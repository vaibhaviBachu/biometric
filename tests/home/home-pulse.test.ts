jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));
jest.mock('../../src/services/exchange/exchange-bridge.service', () => ({ exchangeBridgeService: {} }));
jest.mock('../../src/services/organization/org-access.service', () => ({ getOrganizationIdForUser: jest.fn() }));

import {
  deviceKind, dailySeries, cumulativeSeries, initialsOf, sortNeeds, startOfLocalDay, viewerActor, viewerKey,
} from '../../src/services/home/home-pulse.shapes';
import { __test } from '../../src/services/home/home-pulse.service';

const NOW = new Date('2026-10-29T15:00:00.000Z'); // 20:30 IST
const IST = -330;

function link(over: Record<string, unknown> = {}) {
  return {
    id: 'L1', token: 't1', vaultId: 'v1', filename: 'Brand Guide v3.pdf', isActive: true, expiresAt: null,
    maxViews: null, viewCount: 3, downloadCount: 0, recipientEmail: null, recipientLabel: null,
    createdAt: new Date('2026-10-20T10:00:00Z'), depth: 0, ...over,
  };
}

function log(over: Record<string, unknown> = {}) {
  return {
    id: `log-${Math.random().toString(36).slice(2)}`, createdAt: new Date(NOW.getTime() - 60_000), shareLinkId: 'L1',
    recipientName: null, action: 'VIEWED', sessionId: 's1', deviceFingerprint: null, ipAddress: '1.2.3.4',
    device: 'mobile', userAgent: null, city: 'Bengaluru', gpsCity: null, country: 'IN',
    locationSource: 'ip', riskLevel: 'LOW', isVpn: false, isTor: false, isProxy: false, ...over,
  };
}

const look = { links: new Map(), vaultByDna: new Map(), certVault: new Map(), vaultName: new Map() };

describe('home pulse shapes', () => {
  it('starts "today" at local midnight, not UTC midnight', () => {
    expect(startOfLocalDay(NOW, IST).toISOString()).toBe('2026-10-28T18:30:00.000Z');
    expect(startOfLocalDay(NOW, 0).toISOString()).toBe('2026-10-29T00:00:00.000Z');
    expect(startOfLocalDay(NOW, 99999).toISOString()).toBe('2026-10-29T00:00:00.000Z');
  });

  it('names a viewer only when the owner named the recipient or the viewer typed a name', () => {
    expect(viewerActor({ recipientName: null }, { recipientLabel: null, recipientEmail: null })).toEqual({ label: 'Visitor', initials: 'V', named: false });
    expect(viewerActor({ recipientName: null }, { recipientLabel: 'Meera Rao', recipientEmail: null }).label).toBe('Meera Rao');
    expect(viewerActor({ recipientName: null }, { recipientLabel: null, recipientEmail: 'priya.k@kestrel.in' }).label).toBe('Priya');
    expect(viewerActor({ recipientName: 'Arjun' }, { recipientLabel: 'Meera', recipientEmail: null }).label).toBe('Arjun');
  });

  it('keeps anonymous viewers apart by session and named ones together by name', () => {
    const anon = viewerActor({}, {});
    expect(viewerKey({ id: 'x', sessionId: 'a' }, anon)).not.toBe(viewerKey({ id: 'y', sessionId: 'b' }, anon));
    const meera = viewerActor({}, { recipientLabel: 'Meera' });
    expect(viewerKey({ id: 'x', sessionId: 'a' }, meera)).toBe(viewerKey({ id: 'y', sessionId: 'b' }, meera));
  });

  it('reads devices and initials plainly', () => {
    expect(deviceKind('mobile')).toBe('phone');
    expect(deviceKind('tablet')).toBe('tablet');
    expect(deviceKind(null, 'Mozilla/5.0 (Windows NT 10.0)')).toBe('computer');
    expect(initialsOf('Kestrel legal')).toBe('KL');
    expect(initialsOf('pixelboard.io')).toBe('PI');
  });

  it('counts per local day and keeps running totals', () => {
    const today = startOfLocalDay(NOW, IST);
    const dates = [new Date(NOW.getTime() - 60_000), new Date(today.getTime() - 3_600_000)];
    expect(dailySeries(dates, today)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(cumulativeSeries(dates, today, 10)).toEqual([8, 8, 8, 8, 8, 9, 10]);
  });

  it('orders needs by urgency, newest first within the same tone', () => {
    const sorted = sortNeeds([
      { id: 'a', tone: 'blue', at: null },
      { id: 'b', tone: 'amber', at: '2026-10-29T10:00:00Z' },
      { id: 'c', tone: 'red', at: '2026-10-28T10:00:00Z' },
      { id: 'd', tone: 'amber', at: '2026-10-29T12:00:00Z' },
    ]);
    expect(sorted.map((n) => n.id)).toEqual(['c', 'd', 'b', 'a']);
  });
});

describe('home pulse builders', () => {
  const links = new Map([['L1', link()]]);

  it('groups repeated attempts and counts every one of them', () => {
    const rows = __test.enrich([
      log({ action: 'SCREENSHOT_ATTEMPT' }), log({ action: 'SCREENSHOT_ATTEMPT' }), log({ action: 'SCREENSHOT_ATTEMPT' }),
      log({ action: 'VIEWED', isVpn: true }),
    ] as never, links as never);
    const p = __test.buildProtection(rows, [], [], startOfLocalDay(NOW, IST), look as never);
    expect(p.counts.suspiciousAttempts).toBe(3);
    const blocked = p.events.find((e) => e.kind === 'attempt_blocked');
    expect(blocked?.count).toBe(3);
    expect(blocked?.title).toBe('Screenshot attempts (3) blocked');
    expect(p.events.find((e) => e.kind === 'risky_open')?.status).toBe('Flagged');
  });

  it('counts every saved investigation of today, including ones that found no match', () => {
    const runs = [
      { id: 'r1', createdAt: new Date(NOW.getTime() - 3_600_000), description: 'Investigation: Match confirmed for "Ramappa Temple.jpg" — Ramappa Temple.jpg' },
      { id: 'r2', createdAt: new Date(NOW.getTime() - 7_200_000), description: 'Investigation: No PINIT signature found for "screenshot.png"' },
      { id: 'r3', createdAt: new Date('2026-10-28T10:00:00Z'), description: 'Investigation: Possible match for "old.jpg" — Old.jpg' },
    ];
    const p = __test.buildProtection([], [], [], startOfLocalDay(NOW, IST), look as never, runs as never);
    expect(p.counts.investigations).toBe(2); // yesterday's run is not today's
    const inv = p.events.filter((e) => e.kind === 'investigation');
    expect(inv.map((e) => e.fileName)).toEqual(['Ramappa Temple.jpg', 'screenshot.png']);
    expect(inv.map((e) => e.detail)).toEqual(['Match confirmed', 'No PINIT signature found']);
  });

  it('does not count an announced investigation twice when its saved report is there too', () => {
    const platform = [{ id: 'p1', name: 'investigation.completed', createdAt: new Date(NOW.getTime() - 3_600_000), entityType: 'investigation', entityId: 'i1', body: 'a.jpg — Ownership Verified', payload: null }];
    const runs = [{ id: 'r1', createdAt: new Date(NOW.getTime() - 3_600_000), description: 'Investigation: Match confirmed for "a.jpg"' }];
    const p = __test.buildProtection([], platform as never, [], startOfLocalDay(NOW, IST), look as never, runs as never);
    expect(p.counts.investigations).toBe(1);
    expect(p.events.filter((e) => e.kind === 'investigation')).toHaveLength(1);
  });

  it('reads the file name and result out of a saved investigation', () => {
    expect(__test.readInvestigationRun('Investigation: Possible match for "b.mov" — Original.mov')).toEqual({ fileName: 'b.mov', result: 'Possible match' });
    expect(__test.readInvestigationRun('something unexpected')).toEqual({ fileName: null, result: 'Report ready' });
  });

  it('leaves yesterday out of today\'s protection', () => {
    const rows = __test.enrich([log({ action: 'COPY_ATTEMPT', createdAt: new Date('2026-10-28T10:00:00Z') })] as never, links as never);
    const p = __test.buildProtection(rows, [], [], startOfLocalDay(NOW, IST), look as never);
    expect(p.counts.suspiciousAttempts).toBe(0);
    expect(p.events).toHaveLength(0);
  });

  it('sorts opens into trusted, city-only and flagged', () => {
    const rows = __test.enrich([
      log({ locationSource: 'gps', sessionId: 'a' }),
      log({ locationSource: 'ip', sessionId: 'b' }),
      log({ isVpn: true, sessionId: 'c' }),
    ] as never, links as never);
    const r = __test.buildReach(rows, [link()] as never, [], NOW);
    expect(r.trust).toEqual({ trusted: 1, cityOnly: 1, flagged: 1 });
    expect(r.flagReasons.hiddenNetwork).toBe(1);
    expect(r.exactVisitors).toBe(1);
    expect(r.links.live).toBe(1);
  });

  it('never draws a private file in the web view', () => {
    const rows = __test.enrich([log()] as never, links as never);
    const privateFile = { id: 'v1', name: 'Aadhaar.pdf', mime: 'application/pdf', folder: 'ids', folderStatus: 'auto_filed', folderSuggestion: null };
    const web = __test.buildWeb(rows, [], [], new Map([['v1', privateFile]]), new Map(), NOW);
    expect(web.files).toHaveLength(0);
    const shared = { ...privateFile, name: 'Brand Guide v3.pdf', folder: 'work' };
    const web2 = __test.buildWeb(rows, [], [], new Map([['v1', shared]]), new Map(), NOW);
    expect(web2.files[0]?.kind).toBe('PDF');
    expect(web2.people[0]?.live).toBe(true);
  });

  it('turns an unmask request into approve / decline calls on the existing review route', () => {
    const needs = __test.buildNeeds({
      crawl: [], platform: [], links: [], toSort: 2, now: NOW, vaultByDna: new Map(),
      exchange: { available: false, seller: null, buyer: null },
      unmask: [{ id: 'u1', createdAt: NOW, recipientName: null, device: null, shareLink: { filename: 'Contract.pdf', vaultId: 'v9', recipientLabel: 'Kestrel legal', recipientEmail: null } }] as never,
    });
    expect(needs[0]?.tone).toBe('violet');
    expect(needs[0]?.actions[0]?.api).toEqual({ method: 'POST', path: '/share/unmask-requests/u1/review', body: { action: 'approve' } });
    expect(needs[needs.length - 1]?.id).toBe('tosort');
  });
});
