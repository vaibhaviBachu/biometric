/**
 * Portfolio visit tracking and owner-only deletion.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const mockFindFirst = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindUnique = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockExec = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockQuery = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    portfolio: {
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      delete: (...a: unknown[]) => mockDelete(...a),
    },
    $executeRawUnsafe: (...a: unknown[]) => mockExec(...a),
    $queryRawUnsafe: (...a: unknown[]) => mockQuery(...a),
  },
}));
jest.mock('../../src/lib/request-utils', () => ({ resolveClientIp: () => '203.0.113.9' }));
jest.mock('../../src/services/share/share-link.service', () => ({
  geoFromIp: async () => ({ country: 'India', region: 'Telangana', city: 'Hyderabad' }),
}));

import { recordPortfolioView, portfolioShareSummary, deleteMyPortfolio } from '../../src/services/portfolio/portfolio-views.service';

const req = (headers: Record<string, string> = {}) =>
  ({ headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari', ...headers } }) as never;

beforeEach(() => {
  [mockFindFirst, mockFindUnique, mockExec, mockQuery, mockDelete].forEach((m) => m.mockReset());
});

describe('recordPortfolioView', () => {
  test('stores the visit with an approximate place and the device, not the owner', async () => {
    mockFindFirst.mockResolvedValue({ id: 'p1', slug: 'ashwitha' });
    await recordPortfolioView('Ashwitha', req({ referer: 'https://www.instagram.com/story' }));
    expect(mockExec).toHaveBeenCalledTimes(1);
    const args = mockExec.mock.calls[0] as unknown[];
    expect(String(args[0])).toContain('INSERT INTO "portfolio_view_logs"');
    expect(args).toEqual(expect.arrayContaining(['p1', 'ashwitha', '203.0.113.9', 'Mobile phone', 'iOS', 'India', 'Hyderabad', 'https://www.instagram.com/story']));
  });

  test('an unknown slug records nothing', async () => {
    mockFindFirst.mockResolvedValue(null);
    await recordPortfolioView('nobody', req());
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('a failure while recording never throws (the public page must not break)', async () => {
    mockFindFirst.mockResolvedValue({ id: 'p1', slug: 's' });
    mockExec.mockRejectedValue(new Error('relation "portfolio_view_logs" does not exist'));
    await expect(recordPortfolioView('s', req())).resolves.toBeUndefined();
  });
});

describe('portfolioShareSummary', () => {
  test('no portfolio: nothing is listed', async () => {
    mockFindUnique.mockResolvedValue(null);
    const s = await portfolioShareSummary('u1');
    expect(s.exists).toBe(false);
    expect(s.views.total).toBe(0);
  });

  test('lists the link with real counts and the recent visitors', async () => {
    mockFindUnique.mockResolvedValue({ id: 'p1', slug: 'ashwitha', publishState: 'PUBLISHED', visibility: 'unlisted', publishedAt: new Date('2026-11-05T08:00:00Z'), publishedVersion: 2 });
    const last = new Date('2026-11-05T09:30:00Z');
    mockQuery
      .mockResolvedValueOnce([{ total: 7, recent: 3, last }])
      .mockResolvedValueOnce([{ createdAt: last, city: 'Hyderabad', region: 'Telangana', country: 'India', deviceType: 'Mobile phone', os: 'iOS', browser: 'Safari', referrer: null }]);
    const s = await portfolioShareSummary('u1');
    expect(s).toMatchObject({ exists: true, slug: 'ashwitha', publishState: 'PUBLISHED', publishedVersion: 2 });
    expect(s.views).toEqual({ total: 7, last7Days: 3, lastViewedAt: last.toISOString() });
    expect(s.recent[0]).toMatchObject({ place: 'Hyderabad, Telangana, India', device: 'Mobile phone · iOS · Safari' });
  });

  test('if the view log is not available the link is still listed, with no visits', async () => {
    mockFindUnique.mockResolvedValue({ id: 'p1', slug: 'a', publishState: 'DRAFT', visibility: 'unlisted', publishedAt: null, publishedVersion: 0 });
    mockQuery.mockRejectedValue(new Error('missing table'));
    const s = await portfolioShareSummary('u1');
    expect(s.exists).toBe(true);
    expect(s.views.total).toBe(0);
    expect(s.recent).toEqual([]);
  });
});

describe('deleteMyPortfolio (the only way a portfolio is removed)', () => {
  test('removes the visit history, then the portfolio', async () => {
    mockFindUnique.mockResolvedValue({ id: 'p1' });
    const order: string[] = [];
    mockExec.mockImplementation(async () => { order.push('logs'); });
    mockDelete.mockImplementation(async () => { order.push('portfolio'); });
    await expect(deleteMyPortfolio('u1')).resolves.toEqual({ deleted: true });
    expect(order).toEqual(['logs', 'portfolio']);
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { userId: 'u1' }, select: { id: true } });
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });

  test('a missing log table does not stop the portfolio being deleted', async () => {
    mockFindUnique.mockResolvedValue({ id: 'p1' });
    mockExec.mockRejectedValue(new Error('missing table'));
    await expect(deleteMyPortfolio('u1')).resolves.toEqual({ deleted: true });
    expect(mockDelete).toHaveBeenCalled();
  });

  test('nothing to delete is a 404, and nothing else is touched', async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(deleteMyPortfolio('u1')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });
});
