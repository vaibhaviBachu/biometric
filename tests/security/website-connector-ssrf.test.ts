/**
 * ASH-M04 — `WebsiteConnector` must never fetch a URL that resolves to a private/internal
 * address (SSRF). Before this fix, `fetchRawHtml()` used a bare, unguarded `axios.get()` and
 * `tryPlaywright()` used a bare, unguarded `page.goto()` — neither went through
 * `lib/ssrf-guard.ts`, unlike `webCrawler.crawlUrl()` (already guarded) that this same file also
 * calls. `watchUrls` reaches this connector from user input (monitoring.controller.ts's
 * enrollMonitor/updateWatchUrls), so an attacker-controlled URL pointing at a cloud metadata
 * address or an internal service could be fetched by the production server.
 *
 * The fix validates every URL once, up front in `crawlPage()`, with the real `parseSafeUrl` (not
 * mocked here — the actual security property under test), before any of the three downstream
 * fetch paths (crawl4ai, Playwright, fetchRawHtml) ever runs. `safeRequest` (which
 * `fetchRawHtml` now uses instead of raw axios) is mocked here only to avoid a real network call
 * for the legitimate-URL case — its own behavior is covered by `tests/security/ssrf-guard.test.ts`.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;
const crawlUrl = jest.fn<AnyAsync>();
const safeRequest = jest.fn<AnyAsync>();

jest.mock('../../src/services/crawler/web-crawler.service', () => ({
  webCrawler: { crawlUrl, generateSearchUrls: () => [] },
}));
jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/lib/ssrf-guard', () => {
  const actual = jest.requireActual('../../src/lib/ssrf-guard') as object;
  return { ...actual, safeRequest };
});

import { WebsiteConnector } from '../../src/services/crawler/engine/connectors/website.connector';
import type { ConnectorSearchContext } from '../../src/services/crawler/engine/types';

const baseCtx: ConnectorSearchContext = {
  monitorRecordId: 'mon-1',
  dnaRecordId: 'dna-1',
  ownerUserId: 'user-1',
  filename: 'report.pdf',
  fileType: 'PDF',
  keywords: [],
  watchUrls: [],
};

beforeEach(() => {
  crawlUrl.mockReset();
  safeRequest.mockReset();
});

describe('WebsiteConnector SSRF guard', () => {
  test.each([
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:8001/debug/index',
    'http://localhost:4000/internal',
    'http://10.0.0.5/admin',
    'http://192.168.1.1/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'file:///etc/passwd',
    'ftp://internal-host/',
  ])('a watchUrl targeting an internal/non-http(s) address (%s) is never fetched by any path', async (badUrl) => {
    const connector = new WebsiteConnector();
    const result = await connector.search({ ...baseCtx, watchUrls: [badUrl] });

    expect(result.assets).toEqual([]);
    expect(crawlUrl).not.toHaveBeenCalled();
    expect(safeRequest).not.toHaveBeenCalled();
  });

  test('a legitimate public watchUrl is still crawled (existing behavior preserved)', async () => {
    crawlUrl.mockResolvedValue({ url: 'https://example.com/post', title: 'A real page', text: 'Some real article text that is long enough to count as a document.' });
    safeRequest.mockResolvedValue({ status: 200, headers: {}, body: Buffer.from('<html></html>'), finalUrl: 'https://example.com/post' });

    const connector = new WebsiteConnector();
    const result = await connector.search({ ...baseCtx, watchUrls: ['https://example.com/post'] });

    expect(crawlUrl).toHaveBeenCalledWith('https://example.com/post');
    expect(result.assets.some((a) => a.assetType === 'document')).toBe(true);
  });

  test('a mix of one blocked and one legitimate URL only crawls the legitimate one', async () => {
    crawlUrl.mockResolvedValue({ url: 'https://example.com/post', title: 'A real page', text: 'Some real article text that is long enough to count as a document.' });
    safeRequest.mockResolvedValue({ status: 200, headers: {}, body: Buffer.from('<html></html>'), finalUrl: 'https://example.com/post' });

    const connector = new WebsiteConnector();
    await connector.search({
      ...baseCtx,
      watchUrls: ['http://169.254.169.254/latest/meta-data/', 'https://example.com/post'],
    });

    expect(crawlUrl).toHaveBeenCalledTimes(1);
    expect(crawlUrl).toHaveBeenCalledWith('https://example.com/post');
  });
});
