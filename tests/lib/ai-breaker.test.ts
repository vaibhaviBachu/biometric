/** One failed AI call does not take the AI service offline for everyone. */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { AIEmbeddingsService } from '../../src/services/ai/ai-embeddings.service';

type Internals = { _isOnline: boolean; _recentFailures: number[]; logError(op: string, err: unknown): void };
const slowAnswer = { request: {}, code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' };

let service: AIEmbeddingsService;
let inner: Internals;
beforeEach(() => {
  service = new AIEmbeddingsService();
  inner = service as unknown as Internals;
  inner._isOnline = true;
});

describe('AI client failure counting', () => {
  test('a single slow or failed call leaves the service online', () => {
    inner.logError('cv/compare', slowAnswer);
    expect(inner._isOnline).toBe(true);
  });

  test('three failures within 30 s take it offline', () => {
    inner.logError('cv/compare', slowAnswer);
    inner.logError('cv/compare', slowAnswer);
    expect(inner._isOnline).toBe(true);
    inner.logError('cv/compare', slowAnswer);
    expect(inner._isOnline).toBe(false);
  });

  test('failures older than 30 s do not count', () => {
    inner._recentFailures = [Date.now() - 60_000, Date.now() - 45_000];
    inner.logError('cv/compare', slowAnswer);
    expect(inner._isOnline).toBe(true);
  });

  test('a refused connection means it really is down: offline at once', () => {
    inner.logError('cv/compare', { code: 'ECONNREFUSED' });
    expect(inner._isOnline).toBe(false);
  });

  test('with AI_BREAKER=off the old behaviour returns: the first failure takes it offline', () => {
    process.env['AI_BREAKER'] = 'off';
    try {
      inner.logError('cv/compare', slowAnswer);
      expect(inner._isOnline).toBe(false);
    } finally {
      delete process.env['AI_BREAKER'];
    }
  });
});
