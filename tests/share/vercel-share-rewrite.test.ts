/**
 * The Vercel rewrite that sends link-preview crawlers (and only them) for /s/:token to the backend, which answers with the
 * Open Graph tags. Real people must keep getting the app, and the crawler list must match the one the backend uses.
 */
import fs from 'fs';
import path from 'path';
import { describe, test, expect } from '@jest/globals';
import { isLinkPreviewCrawler } from '../../src/services/share/share-preview.service';

interface Rewrite { source: string; destination: string; has?: Array<{ type: string; key: string; value: string }> }
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'vercel.json'), 'utf8')) as { rewrites: Rewrite[] };
const rule = config.rewrites.find((r) => r.source === '/s/:token');

const CRAWLERS = [
  'WhatsApp/2.23.20.0 A',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (compatible; Twitterbot/1.0)',
  'TelegramBot (like TwitterBot)',
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  'LinkedInBot/1.0 (compatible; Mozilla/5.0)',
];
const PEOPLE = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
];

describe('client/vercel.json', () => {
  test('has a share-link rule for crawlers, ahead of the app catch-all', () => {
    expect(rule).toBeDefined();
    expect(config.rewrites.indexOf(rule!)).toBe(0);
    expect(rule!.destination).toMatch(/^https:\/\/[a-z0-9.-]+\/s\/:token$/);
  });

  test('applies only when the user agent is a link-preview crawler', () => {
    expect(rule!.has).toHaveLength(1);
    expect(rule!.has![0]).toMatchObject({ type: 'header', key: 'user-agent' });
    const re = new RegExp(rule!.has![0]!.value);
    for (const ua of CRAWLERS) expect(re.test(ua)).toBe(true);
    for (const ua of PEOPLE) expect(re.test(ua)).toBe(false);
  });

  test('agrees with the crawler list the backend uses', () => {
    const re = new RegExp(rule!.has![0]!.value);
    for (const ua of [...CRAWLERS, ...PEOPLE]) expect(re.test(ua)).toBe(isLinkPreviewCrawler(ua));
  });

  test('the other rewrites (the single-page app) are still there', () => {
    expect(config.rewrites.some((r) => r.destination === '/index.html')).toBe(true);
  });
});
