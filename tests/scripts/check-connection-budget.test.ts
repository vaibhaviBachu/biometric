/**
 * Phase 3 — connection-budget guard script.
 * Phase 5 — extended for worker-instance demand (src/worker.ts). Previously
 * this script and its tests had no concept of a worker instance at all,
 * understating total connection demand for any deployment that runs
 * worker.ts alongside Hub/Exchange — exactly the scenario Phase 5's queue
 * activation is a prerequisite for.
 *
 * Pure-function test: no database, no network. Verifies the arithmetic and
 * pass/fail threshold against Production Readiness DB-GAP-34's conservative
 * 53-of-60-connection safe budget.
 */
import { describe, test, expect } from '@jest/globals';
import { parseArgs, evaluateBudget } from '../../scripts/check-connection-budget';

describe('parseArgs', () => {
  test('applies documented defaults when no flags are given (worker defaults to 0 instances)', () => {
    expect(parseArgs([])).toEqual({
      hubInstances: 1,
      exchangeInstances: 1,
      workerInstances: 0,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 10,
      safeBudget: 53,
    });
  });

  test('parses provided flags, including worker flags', () => {
    expect(parseArgs(['--hub=5', '--exchange=5', '--worker=3', '--limit=10', '--worker-limit=8', '--budget=53'])).toEqual({
      hubInstances: 5,
      exchangeInstances: 5,
      workerInstances: 3,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 8,
      safeBudget: 53,
    });
  });

  test('rejects a non-numeric value', () => {
    expect(() => parseArgs(['--hub=abc'])).toThrow('Invalid value for --hub');
  });

  test('rejects a negative value', () => {
    expect(() => parseArgs(['--hub=-1'])).toThrow('Invalid value for --hub');
  });

  test('rejects a negative worker value', () => {
    expect(() => parseArgs(['--worker=-1'])).toThrow('Invalid value for --worker');
  });
});

describe('evaluateBudget', () => {
  test('Scenario A (current, 1+1 instances, 0 workers) is comfortably within budget', () => {
    const result = evaluateBudget({
      hubInstances: 1,
      exchangeInstances: 1,
      workerInstances: 0,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 10,
      safeBudget: 53,
    });
    expect(result.totalDemand).toBe(20);
    expect(result.withinBudget).toBe(true);
    expect(result.headroom).toBe(33);
  });

  test('Scenario B (2 Hub + 2 Exchange, 0 workers) is within the conservative budget', () => {
    const result = evaluateBudget({
      hubInstances: 2,
      exchangeInstances: 2,
      workerInstances: 0,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 10,
      safeBudget: 53,
    });
    expect(result.totalDemand).toBe(40);
    expect(result.withinBudget).toBe(true);
  });

  test('Scenario C (5 Hub + 5 Exchange, 0 workers) exceeds the 60-connection ceiling, matching Report 2 §3', () => {
    const result = evaluateBudget({
      hubInstances: 5,
      exchangeInstances: 5,
      workerInstances: 0,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 10,
      safeBudget: 53,
    });
    expect(result.totalDemand).toBe(100);
    expect(result.withinBudget).toBe(false);
    expect(result.headroom).toBe(-47);
  });

  test('a deployment landing exactly on the safe budget passes (boundary inclusive)', () => {
    const result = evaluateBudget({
      hubInstances: 3,
      exchangeInstances: 2,
      workerInstances: 0,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 10,
      safeBudget: 50,
    });
    expect(result.totalDemand).toBe(50);
    expect(result.withinBudget).toBe(true);
    expect(result.headroom).toBe(0);
  });

  test('one connection over budget fails', () => {
    const result = evaluateBudget({
      hubInstances: 3,
      exchangeInstances: 2,
      workerInstances: 0,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 10,
      safeBudget: 49,
    });
    expect(result.withinBudget).toBe(false);
  });

  test('Phase 5 Scenario D: 1 Hub + 1 Exchange + 2 workers at the default limit fits the safe budget', () => {
    // 1x Hub(10) + 1x Exchange(10) + 2x Worker(10) = 40 <= 53
    const result = evaluateBudget({
      hubInstances: 1,
      exchangeInstances: 1,
      workerInstances: 2,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 10,
      safeBudget: 53,
    });
    expect(result.totalDemand).toBe(40);
    expect(result.withinBudget).toBe(true);
    expect(result.headroom).toBe(13);
  });

  test('Phase 5 Scenario E: 2 Hub + 2 Exchange + 2 workers exceeds the safe budget — workers are the deciding factor', () => {
    // Without workers this is Scenario B (40, within budget). Adding 2 workers
    // at the default limit pushes it to 60, over the 53 safe budget — exactly
    // the kind of regression this script exists to catch before a worker
    // fleet is sized without accounting for its own connection demand.
    const result = evaluateBudget({
      hubInstances: 2,
      exchangeInstances: 2,
      workerInstances: 2,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 10,
      safeBudget: 53,
    });
    expect(result.totalDemand).toBe(60);
    expect(result.withinBudget).toBe(false);
    expect(result.headroom).toBe(-7);
  });

  test('a lower worker-specific connection_limit (e.g. tuned DATABASE_URL for worker.ts) reduces total demand', () => {
    const result = evaluateBudget({
      hubInstances: 1,
      exchangeInstances: 1,
      workerInstances: 3,
      perInstanceLimit: 10,
      workerPerInstanceLimit: 4,
      safeBudget: 53,
    });
    expect(result.totalDemand).toBe(32); // 20 + 3*4
    expect(result.withinBudget).toBe(true);
    expect(result.headroom).toBe(21);
  });
});
