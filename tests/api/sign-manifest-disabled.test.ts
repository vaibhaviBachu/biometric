/**
 * When report signing is switched off, POST /evidence/sign-manifest says so at once, before the login and subscription
 * lookups (several database round trips) that cannot change the answer.
 */
let mockSigningActive = false;

jest.mock('../../src/config/dna-phase3', () => ({
  ...jest.requireActual('../../src/config/dna-phase3'),
  isPhase3SignedReportsActive: () => mockSigningActive,
}));

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { evidenceRouter } from '../../src/api/routes/evidence.routes';
import { errorMiddleware } from '../../src/api/middleware/error.middleware';

let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/evidence', evidenceRouter);
  app.use(errorMiddleware);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const post = () => fetch(`${base}/api/v1/evidence/sign-manifest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ investigationId: 'x', reportType: 'INVESTIGATION', reportHash: 'h' }),
});

describe('POST /evidence/sign-manifest', () => {
  test('signing off: 503 "Report signing is disabled", even without a login (nothing was looked up first)', async () => {
    mockSigningActive = false;
    const res = await post();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toMatch(/Report signing is disabled/);
  });

  test('signing on: the normal checks run first, so an anonymous caller is refused as before (401)', async () => {
    mockSigningActive = true;
    expect((await post()).status).toBe(401);
  });
});
