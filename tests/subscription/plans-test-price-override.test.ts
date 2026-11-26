/**
 * Phase 1 Razorpay Test Mode — test-price/storage override safety.
 *
 * Covers: server-authoritative test pricing, the real ₹999 plan staying
 * untouched, and the fail-closed behavior required when the override is
 * enabled against a live-looking key or is only half-configured.
 */
import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import { config } from '../../src/config';
import {
  PLAN_DEFINITIONS,
  PlanCode,
  resolveEffectivePlan,
  resolveEffectivePlanDefinitions,
  testPriceOverrideStatus,
  UnsafeTestPriceOverrideError,
} from '../../src/services/subscription/constants/plans';

// `config` is typed `as const` (deeply readonly) for production code; this
// test-only alias is the same underlying object, just without that type
// restriction, so these tests can simulate different env states.
const mutableConfig = config as unknown as {
  env: string;
  razorpay: { keyId: string; keySecret: string; webhookSecret: string };
  subscription: { testPriceOverrideEnabled: boolean; testProPricePaise: number; testProStorageGb: number };
};

const originalRazorpayKeyId = config.razorpay.keyId;
const originalOverride = { ...config.subscription };

function resetConfig() {
  mutableConfig.razorpay.keyId = originalRazorpayKeyId;
  Object.assign(mutableConfig.subscription, originalOverride);
  mutableConfig.subscription.testPriceOverrideEnabled = false;
  mutableConfig.subscription.testProPricePaise = 0;
  mutableConfig.subscription.testProStorageGb = 0;
}

describe('Razorpay test-price override', () => {
  beforeEach(resetConfig);
  afterEach(resetConfig);

  test('disabled: PRO resolves to the real ₹999 / 100 GB plan, unchanged', () => {
    mutableConfig.subscription.testPriceOverrideEnabled =false;
    const resolved = resolveEffectivePlan(PlanCode.PRO);
    expect(resolved.pricePaise).toBe(PLAN_DEFINITIONS.PRO.pricePaise);
    expect(resolved.priceInr).toBe(999);
    expect(resolved.storageLimitBytes).toBe(PLAN_DEFINITIONS.PRO.storageLimitBytes);
  });

  test('PLAN_DEFINITIONS.PRO itself is never mutated by resolving the override', () => {
    mutableConfig.razorpay.keyId ='rzp_test_abc123';
    mutableConfig.subscription.testPriceOverrideEnabled =true;
    mutableConfig.subscription.testProPricePaise =1000;
    mutableConfig.subscription.testProStorageGb =3;

    resolveEffectivePlan(PlanCode.PRO);

    expect(PLAN_DEFINITIONS.PRO.pricePaise).toBe(99900);
    expect(PLAN_DEFINITIONS.PRO.priceInr).toBe(999);
  });

  test('enabled + Test Mode key + fully configured: PRO resolves to ₹10 / 3 GB', () => {
    mutableConfig.razorpay.keyId ='rzp_test_abc123';
    mutableConfig.subscription.testPriceOverrideEnabled =true;
    mutableConfig.subscription.testProPricePaise =1000; // ₹10
    mutableConfig.subscription.testProStorageGb =3;

    const resolved = resolveEffectivePlan(PlanCode.PRO);
    expect(resolved.pricePaise).toBe(1000);
    expect(resolved.priceInr).toBe(10);
    expect(resolved.storageLimitBytes).toBe(3 * 1024 * 1024 * 1024);
    expect(resolved.description).toMatch(/TEST PRICE ACTIVE/);
  });

  test('FREE and ENTERPRISE are never affected by the override', () => {
    mutableConfig.razorpay.keyId ='rzp_test_abc123';
    mutableConfig.subscription.testPriceOverrideEnabled =true;
    mutableConfig.subscription.testProPricePaise =1000;
    mutableConfig.subscription.testProStorageGb =3;

    expect(resolveEffectivePlan(PlanCode.FREE)).toEqual(PLAN_DEFINITIONS.FREE);
    expect(resolveEffectivePlan(PlanCode.ENTERPRISE)).toEqual(PLAN_DEFINITIONS.ENTERPRISE);
  });

  test('FAILS CLOSED: enabled against a live key (rzp_live_...) throws, does not apply or ignore', () => {
    mutableConfig.razorpay.keyId ='rzp_live_realmoney';
    mutableConfig.subscription.testPriceOverrideEnabled =true;
    mutableConfig.subscription.testProPricePaise =1000;
    mutableConfig.subscription.testProStorageGb =3;

    expect(() => testPriceOverrideStatus()).toThrow(UnsafeTestPriceOverrideError);
    expect(() => resolveEffectivePlan(PlanCode.PRO)).toThrow(UnsafeTestPriceOverrideError);
  });

  test('FAILS CLOSED: enabled but price missing throws rather than charging ₹0', () => {
    mutableConfig.razorpay.keyId ='rzp_test_abc123';
    mutableConfig.subscription.testPriceOverrideEnabled =true;
    mutableConfig.subscription.testProPricePaise =0;
    mutableConfig.subscription.testProStorageGb =3;

    expect(() => testPriceOverrideStatus()).toThrow(UnsafeTestPriceOverrideError);
  });

  test('FAILS CLOSED: enabled but storage missing throws rather than granting 0 GB', () => {
    mutableConfig.razorpay.keyId ='rzp_test_abc123';
    mutableConfig.subscription.testPriceOverrideEnabled =true;
    mutableConfig.subscription.testProPricePaise =1000;
    mutableConfig.subscription.testProStorageGb =0;

    expect(() => testPriceOverrideStatus()).toThrow(UnsafeTestPriceOverrideError);
  });

  test('empty RAZORPAY_KEY_ID (no key configured) is treated as non-live, override applies', () => {
    mutableConfig.razorpay.keyId ='';
    mutableConfig.subscription.testPriceOverrideEnabled =true;
    mutableConfig.subscription.testProPricePaise =1000;
    mutableConfig.subscription.testProStorageGb =3;

    expect(() => testPriceOverrideStatus()).not.toThrow();
    expect(testPriceOverrideStatus().active).toBe(true);
  });

  test('resolveEffectivePlanDefinitions() returns the full catalog with only PRO overridden', () => {
    mutableConfig.razorpay.keyId ='rzp_test_abc123';
    mutableConfig.subscription.testPriceOverrideEnabled =true;
    mutableConfig.subscription.testProPricePaise =1000;
    mutableConfig.subscription.testProStorageGb =3;

    const all = resolveEffectivePlanDefinitions();
    expect(all.FREE).toEqual(PLAN_DEFINITIONS.FREE);
    expect(all.ENTERPRISE).toEqual(PLAN_DEFINITIONS.ENTERPRISE);
    expect(all.PRO.priceInr).toBe(10);
  });
});
