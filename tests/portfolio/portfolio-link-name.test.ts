/**
 * The portfolio link name follows the profile name while it is still a placeholder, and never touches a live link
 * or a name the owner chose.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { isPlaceholderSlug, slugifyName } from '../../src/services/portfolio/portfolio-document';

const mockUser = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFind = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindFirst = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUpdate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => mockUser(...a) },
    portfolio: {
      findUnique: (...a: unknown[]) => mockFind(...a),
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
  },
}));

import { portfolioService } from '../../src/services/portfolio/portfolio.service';

const user = (fullName: string) => ({ id: 'u1', shortId: 'P8N5UUTZ', fullName, avatarUrl: null, bio: '', updatedAt: new Date() });

beforeEach(() => {
  [mockUser, mockFind, mockFindFirst, mockUpdate].forEach((m) => m.mockReset());
  mockFindFirst.mockResolvedValue(null); // nobody else holds the name
  mockUpdate.mockImplementation(async (arg) => ({ id: 'p1', userId: 'u1', publishState: 'DRAFT', ...(arg as { data: object }).data }));
});

describe('placeholder link names', () => {
  test('recognises placeholders only', () => {
    expect(isPlaceholderSlug('pinituser')).toBe(true);
    expect(isPlaceholderSlug('Creator')).toBe(true);
    expect(isPlaceholderSlug('kavvamashwitha')).toBe(false);
    expect(isPlaceholderSlug('')).toBe(false);
    expect(slugifyName('Kavvam Ashwitha')).toBe('kavvamashwitha');
  });
});

describe('getOrCreate', () => {
  test('a draft with the placeholder name takes the profile name', async () => {
    mockUser.mockResolvedValue(user('Kavvam Ashwitha'));
    mockFind.mockResolvedValue({ id: 'p1', userId: 'u1', slug: 'pinituser', publishState: 'DRAFT' });
    const row = await portfolioService.getOrCreate('u1') as { slug: string };
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { slug: 'kavvamashwitha' } });
    expect(row.slug).toBe('kavvamashwitha');
  });

  test('a published link is never renamed', async () => {
    mockUser.mockResolvedValue(user('Kavvam Ashwitha'));
    mockFind.mockResolvedValue({ id: 'p1', userId: 'u1', slug: 'pinituser', publishState: 'PUBLISHED' });
    await portfolioService.getOrCreate('u1');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a name the owner chose is never renamed', async () => {
    mockUser.mockResolvedValue(user('Kavvam Ashwitha'));
    mockFind.mockResolvedValue({ id: 'p1', userId: 'u1', slug: 'ashwitha-photos', publishState: 'DRAFT' });
    await portfolioService.getOrCreate('u1');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('if the profile has no real name yet, the placeholder stays', async () => {
    mockUser.mockResolvedValue(user('PINIT User'));
    mockFind.mockResolvedValue({ id: 'p1', userId: 'u1', slug: 'pinituser', publishState: 'DRAFT' });
    await portfolioService.getOrCreate('u1');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
