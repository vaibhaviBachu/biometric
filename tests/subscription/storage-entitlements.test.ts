/**
 * Phase 1B — free-trial (2 GB / 14 days, expiring) and permanent purchased
 * storage (never expires, additive), and their combined effective quota.
 */
import { describe, test, beforeEach, expect, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncMock = jest.Mock<(...args: any[]) => Promise<any>>;
function asyncMock(): AsyncMock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest.fn<() => Promise<any>>() as unknown as AsyncMock;
}

const mockPrisma = {
  user: { findUnique: asyncMock() },
  subscription: { findUnique: asyncMock() },
  storageGrant: { findFirst: asyncMock(), findMany: asyncMock(), create: asyncMock() },
  organization: { findUnique: asyncMock() },
  organizationMember: { count: asyncMock() },
  featureEntitlement: { findMany: asyncMock() },
};

jest.mock('../../src/lib/prisma', () => ({ prisma: mockPrisma }));

jest.mock('../../src/services/subscription/subscription.service', () => ({
  subscriptionService: { ensureDefaultSubscription: jest.fn(async () => undefined) },
}));

const mockGetUsedBytes = asyncMock();
jest.mock('../../src/services/subscription/usage/storage-usage.service', () => ({
  storageUsageService: { getUsedBytes: mockGetUsedBytes },
}));

jest.mock('../../src/services/subscription/usage/asset-quota.service', () => ({
  assetQuotaService: { getProtectedAssetCount: jest.fn(async () => 0) },
}));

import { config } from '../../src/config';
import { entitlementService } from '../../src/services/subscription/entitlements/entitlement.service';
import { PlanCode } from '../../src/services/subscription/constants/plans';

const mutableConfig = config as unknown as {
  subscription: { testPriceOverrideEnabled: boolean; testProPricePaise: number; testProStorageGb: number };
  razorpay: { keyId: string };
};

const USER_A = 'user-a-uuid';
const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function freeUser() {
  mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
  mockPrisma.subscription.findUnique.mockResolvedValue({
    status: 'ACTIVE',
    plan: { code: 'FREE' },
  });
}

describe('Phase 1B storage entitlements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutableConfig.razorpay.keyId = 'rzp_test_fixture';
    mutableConfig.subscription.testPriceOverrideEnabled = false;
    mutableConfig.subscription.testProPricePaise = 0;
    mutableConfig.subscription.testProStorageGb = 0;
    mockGetUsedBytes.mockResolvedValue(0);
    mockPrisma.featureEntitlement.findMany.mockResolvedValue([]);
    freeUser();
  });

  describe('ensureTrialGrant', () => {
    test('creates a 2 GB / 14-day trial grant for a user who has none', async () => {
      mockPrisma.storageGrant.findFirst.mockResolvedValue(null);

      await entitlementService.ensureTrialGrant(USER_A);

      expect(mockPrisma.storageGrant.create).toHaveBeenCalledTimes(1);
      const call = mockPrisma.storageGrant.create.mock.calls[0][0] as { data: { type: string; bytesGranted: bigint; expiresAt: Date } };
      expect(call.data.type).toBe('TRIAL');
      expect(call.data.bytesGranted).toBe(BigInt(2 * GB));
      const daysUntilExpiry = Math.round((call.data.expiresAt.getTime() - Date.now()) / 86_400_000);
      expect(daysUntilExpiry).toBe(14);
    });

    test('is idempotent — does not create a second trial for a user who already has one', async () => {
      mockPrisma.storageGrant.findFirst.mockResolvedValue({
        id: 'grant-1', type: 'TRIAL', bytesGranted: BigInt(2 * GB), expiresAt: new Date(Date.now() + 86_400_000),
      });

      await entitlementService.ensureTrialGrant(USER_A);

      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
    });

    test('repeated calls (simulating a repeatedly-invoked init endpoint) never create more than one trial', async () => {
      // First call: no existing grant, creates one.
      mockPrisma.storageGrant.findFirst.mockResolvedValueOnce(null);
      await entitlementService.ensureTrialGrant(USER_A);
      expect(mockPrisma.storageGrant.create).toHaveBeenCalledTimes(1);

      // Every subsequent call: the grant now exists, so no more creates.
      mockPrisma.storageGrant.findFirst.mockResolvedValue({ id: 'grant-1', type: 'TRIAL' });
      await entitlementService.ensureTrialGrant(USER_A);
      await entitlementService.ensureTrialGrant(USER_A);
      await entitlementService.ensureTrialGrant(USER_A);
      expect(mockPrisma.storageGrant.create).toHaveBeenCalledTimes(1);
    });

    test('a concurrent-creation race (DB unique-violation) is swallowed, not thrown', async () => {
      mockPrisma.storageGrant.findFirst.mockResolvedValue(null);
      const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      mockPrisma.storageGrant.create.mockRejectedValue(uniqueViolation);

      await expect(entitlementService.ensureTrialGrant(USER_A)).resolves.toBeUndefined();
    });
  });

  describe('getStorageLimitBytes — trial', () => {
    test('an unexpired trial grants its full 2 GB on top of the FREE floor', async () => {
      mockPrisma.storageGrant.findFirst.mockResolvedValue({
        id: 'g1', type: 'TRIAL', bytesGranted: BigInt(2 * GB), expiresAt: new Date(Date.now() + 86_400_000),
      });
      mockPrisma.storageGrant.findMany.mockResolvedValue([
        { id: 'g1', type: 'TRIAL', bytesGranted: BigInt(2 * GB), expiresAt: new Date(Date.now() + 86_400_000) },
      ]);

      const limit = await entitlementService.getStorageLimitBytes(USER_A);
      expect(limit).toBe(2 * GB); // FREE floor is also 2 GB, so this is both — not a double count
    });

    test('an EXPIRED trial grants ZERO bytes — the free allowance genuinely expires, no silent floor', async () => {
      const expired = { id: 'g1', type: 'TRIAL', bytesGranted: BigInt(2 * GB), expiresAt: new Date(Date.now() - 86_400_000) };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(expired);
      mockPrisma.storageGrant.findMany.mockResolvedValue([expired]);

      const limit = await entitlementService.getStorageLimitBytes(USER_A);
      // A FREE-tier user's limit IS the grants total — there is no separate
      // "plan floor" fallback for FREE (unlike PRO/ENTERPRISE), because
      // PLAN_DEFINITIONS.FREE.storageLimitBytes is the trial allowance
      // itself, not an independent permanent floor underneath it.
      expect(limit).toBe(0);
    });

    test('a NEW upload is refused once the trial has expired, via assertStorageAvailable', async () => {
      const expired = { id: 'g1', type: 'TRIAL', bytesGranted: BigInt(2 * GB), expiresAt: new Date(Date.now() - 86_400_000) };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(expired);
      mockPrisma.storageGrant.findMany.mockResolvedValue([expired]);

      await expect(
        entitlementService.assertStorageAvailable(USER_A, 1024),
      ).rejects.toThrow('Not enough Vault storage. Upgrade your storage to protect this asset.');
    });
  });

  describe('retention is separate from entitlement — expiry never touches stored files', () => {
    test('existing stored bytes are still reported after the trial expires — nothing was deleted', async () => {
      const expired = { id: 'g1', type: 'TRIAL', bytesGranted: BigInt(2 * GB), expiresAt: new Date(Date.now() - 86_400_000) };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(expired);
      mockPrisma.storageGrant.findMany.mockResolvedValue([expired]);
      // Simulates a user who used 1.5 GB of their trial before it expired —
      // those bytes are still genuinely stored in the Vault.
      mockGetUsedBytes.mockResolvedValue(1.5 * GB);

      const view = await entitlementService.getSubscriptionView(USER_A);

      // The allowance is gone (requirement: expired trial grants nothing)...
      expect(view.storageLimitBytes).toBe(0);
      // ...but what's actually stored is completely unaffected — read
      // straight from storageUsageService, never zeroed, never zeroed out
      // or recomputed based on the entitlement. These two numbers are
      // independent on purpose: one is "what you're allowed," the other is
      // "what exists." No code path here calls anything that deletes a file.
      expect(view.storageUsedBytes).toBe(1.5 * GB);
      expect(view.trialActive).toBe(false);
    });

    test('an expired trial still blocks new uploads even though old files remain (limit enforced, retention untouched)', async () => {
      const expired = { id: 'g1', type: 'TRIAL', bytesGranted: BigInt(2 * GB), expiresAt: new Date(Date.now() - 86_400_000) };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(expired);
      mockPrisma.storageGrant.findMany.mockResolvedValue([expired]);
      mockGetUsedBytes.mockResolvedValue(1.5 * GB); // 1.5 GB of real, still-stored files

      const err = await entitlementService.assertStorageAvailable(USER_A, 10 * MB).catch((e: unknown) => e);

      // Refused for the NEW upload...
      expect(err).toMatchObject({ name: 'StorageLimitError' });
      // ...but assertStorageAvailable only ever compares numbers; it is
      // never given the ability to delete anything, and nothing it calls
      // (getStorageLimitBytes, storageUsageService.getUsedBytes) does either.
      expect(mockGetUsedBytes).toHaveBeenCalledWith(USER_A);
    });
  });

  describe('getStorageLimitBytes — purchased capacity', () => {
    test('a single 3 GB purchase (PRO test price) raises the limit to 3 GB', async () => {
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testProPricePaise = 1000;
      mutableConfig.subscription.testProStorageGb = 3;
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
      mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'ACTIVE', plan: { code: 'PRO' } });

      const purchased = { id: 'g2', type: 'PURCHASED', bytesGranted: BigInt(3 * GB), expiresAt: null };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(purchased);
      mockPrisma.storageGrant.findMany.mockResolvedValue([purchased]);

      const limit = await entitlementService.getStorageLimitBytes(USER_A);
      expect(limit).toBe(3 * GB);
    });

    test('a second purchase adds to the first: 3 GB + 3 GB = 6 GB (PINITHUB Phase 1B §C example)', async () => {
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testProPricePaise = 1000;
      mutableConfig.subscription.testProStorageGb = 3;
      mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'ACTIVE', plan: { code: 'PRO' } });

      const firstPurchase = { id: 'g2', type: 'PURCHASED', bytesGranted: BigInt(3 * GB), expiresAt: null };
      const secondPurchase = { id: 'g3', type: 'PURCHASED', bytesGranted: BigInt(3 * GB), expiresAt: null };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(firstPurchase);
      mockPrisma.storageGrant.findMany.mockResolvedValue([firstPurchase, secondPurchase]);

      const limit = await entitlementService.getStorageLimitBytes(USER_A);
      expect(limit).toBe(6 * GB);
    });

    test('purchased capacity is unaffected by an expired trial existing alongside it', async () => {
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testProPricePaise = 1000;
      mutableConfig.subscription.testProStorageGb = 3;
      mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'ACTIVE', plan: { code: 'PRO' } });

      const expiredTrial = { id: 'g1', type: 'TRIAL', bytesGranted: BigInt(2 * GB), expiresAt: new Date(Date.now() - 86_400_000) };
      const purchased = { id: 'g2', type: 'PURCHASED', bytesGranted: BigInt(3 * GB), expiresAt: null };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(expiredTrial);
      mockPrisma.storageGrant.findMany.mockResolvedValue([expiredTrial, purchased]);

      const limit = await entitlementService.getStorageLimitBytes(USER_A);
      expect(limit).toBe(3 * GB); // the expired trial's 2 GB is not added, the purchased 3 GB is untouched
    });

    test('an admin-assigned ENTERPRISE account stays unlimited regardless of grants', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'SUPER_ADMIN' });
      const limit = await entitlementService.getStorageLimitBytes(USER_A);
      expect(limit).toBeNull();
    });
  });
});

describe('Phase 1C — permanent PRO feature access, independent of subscription status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutableConfig.razorpay.keyId = 'rzp_test_fixture';
    mutableConfig.subscription.testPriceOverrideEnabled = false;
    mutableConfig.subscription.testProPricePaise = 0;
    mutableConfig.subscription.testProStorageGb = 0;
  });

  test('a user on a CANCELED subscription (resolves to FREE) still has PRO features via a permanent FeatureEntitlement override', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    // The subscription itself looks lapsed — getEffectivePlanCode would
    // resolve this to FREE on its own.
    mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'CANCELED', plan: { code: 'PRO' } });
    mockPrisma.featureEntitlement.findMany.mockResolvedValue([
      { userId: USER_A, featureKey: 'FEATURE_INVESTIGATION', enabled: true },
      { userId: USER_A, featureKey: 'FEATURE_TRACKING', enabled: true },
    ]);

    const features = await entitlementService.getFeaturesForUser(USER_A);

    expect(features).toContain('FEATURE_INVESTIGATION');
    expect(features).toContain('FEATURE_TRACKING');
  });

  test('an EXPIRED subscription status does not remove a permanently-granted feature', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'EXPIRED', plan: { code: 'PRO' } });
    mockPrisma.featureEntitlement.findMany.mockResolvedValue([
      { userId: USER_A, featureKey: 'FEATURE_SMART_SHARE', enabled: true },
    ]);

    const hasFeature = await entitlementService.hasFeature(USER_A, 'FEATURE_SMART_SHARE' as never);
    expect(hasFeature).toBe(true);
  });

  test('a disabled override still correctly removes a feature the base plan would have granted', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'ACTIVE', plan: { code: 'PRO' } });
    mockPrisma.featureEntitlement.findMany.mockResolvedValue([
      { userId: USER_A, featureKey: 'FEATURE_TRACKING', enabled: false },
    ]);

    const features = await entitlementService.getFeaturesForUser(USER_A);
    expect(features).not.toContain('FEATURE_TRACKING');
  });

  test('capstone: an expired trial, a lapsed subscription status, and real stored files all coexist correctly with permanent purchased storage and permanent PRO features', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    // The subscription itself looks lapsed (status EXPIRED) — if anything
    // here still depended on currentPeriodEnd/status, this is where it
    // would show up as a regression.
    mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'EXPIRED', plan: { code: 'PRO' } });
    const expiredTrial = { id: 'g1', type: 'TRIAL', bytesGranted: BigInt(2 * GB), expiresAt: new Date(Date.now() - 999 * 86_400_000) };
    const purchased = { id: 'g2', type: 'PURCHASED', bytesGranted: BigInt(3 * GB), expiresAt: null };
    mockPrisma.storageGrant.findFirst.mockResolvedValue(expiredTrial);
    mockPrisma.storageGrant.findMany.mockResolvedValue([expiredTrial, purchased]);
    mockPrisma.featureEntitlement.findMany.mockResolvedValue([
      { userId: USER_A, featureKey: 'FEATURE_INVESTIGATION', enabled: true },
      { userId: USER_A, featureKey: 'FEATURE_TRACKING', enabled: true },
    ]);
    mockGetUsedBytes.mockResolvedValue(2.8 * GB); // real files, still there

    const limit = await entitlementService.getStorageLimitBytes(USER_A);
    const features = await entitlementService.getFeaturesForUser(USER_A);
    const view = await entitlementService.getSubscriptionView(USER_A);

    expect(limit).toBe(3 * GB); // purchased storage intact; the dead trial contributes nothing
    expect(features).toContain('FEATURE_INVESTIGATION');
    expect(features).toContain('FEATURE_TRACKING');
    expect(view.storageUsedBytes).toBe(2.8 * GB); // existing files, untouched and still counted
    expect(view.purchasedStorageBytes).toBe(3 * GB);
    expect(view.trialActive).toBe(false);
  });

  describe('storage top-up packs', () => {
    test('a mid-cycle top-up on an active PRO subscription adds to, not replaces, the plan allowance', async () => {
      // The feature's own worked example: 3 GB plan, fully used, +2 GB
      // top-up purchased mid-cycle → 5 GB total, immediately. A real PRO
      // subscriber already has a 3 GB StorageGrant from their original
      // subscription purchase (activatePendingBilling creates one for
      // every non-ENTERPRISE plan) — the top-up is a second, independent
      // grant on top of that, not a replacement of the plan floor.
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
      mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'ACTIVE', plan: { code: 'PRO' } });
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testProPricePaise = 1000;
      mutableConfig.subscription.testProStorageGb = 3;
      const subscriptionGrant = { id: 'sub-grant-1', type: 'PURCHASED', bytesGranted: BigInt(3 * GB), expiresAt: null };
      const topUpGrant = { id: 'topup-1', type: 'PURCHASED', bytesGranted: BigInt(2 * GB), expiresAt: null };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(null); // no trial grant for this user
      mockPrisma.storageGrant.findMany.mockResolvedValue([subscriptionGrant, topUpGrant]);
      mockGetUsedBytes.mockResolvedValue(3 * GB); // plan's 3 GB fully consumed

      const limit = await entitlementService.getStorageLimitBytes(USER_A);
      expect(limit).toBe((3 + 2) * GB);

      await expect(entitlementService.assertStorageAvailable(USER_A, 1 * GB)).resolves.not.toThrow();
    });

    test('two top-ups accumulate additively — each is its own StorageGrant row, summed', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
      mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'ACTIVE', plan: { code: 'FREE' } });
      const topUpA = { id: 'topup-a', type: 'PURCHASED', bytesGranted: BigInt(1 * GB), expiresAt: null };
      const topUpB = { id: 'topup-b', type: 'PURCHASED', bytesGranted: BigInt(5 * GB), expiresAt: null };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(null);
      mockPrisma.storageGrant.findMany.mockResolvedValue([topUpA, topUpB]);

      const view = await entitlementService.getSubscriptionView(USER_A);
      expect(view.purchasedStorageBytes).toBe((1 + 5) * GB);
    });

    test('an upload that exceeds the combined (plan + top-up) quota is still rejected by the backend', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
      mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'ACTIVE', plan: { code: 'PRO' } });
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testProPricePaise = 1000;
      mutableConfig.subscription.testProStorageGb = 3;
      const subscriptionGrant = { id: 'sub-grant-2', type: 'PURCHASED', bytesGranted: BigInt(3 * GB), expiresAt: null };
      const topUpGrant = { id: 'topup-2', type: 'PURCHASED', bytesGranted: BigInt(2 * GB), expiresAt: null };
      mockPrisma.storageGrant.findFirst.mockResolvedValue(null);
      mockPrisma.storageGrant.findMany.mockResolvedValue([subscriptionGrant, topUpGrant]);
      mockGetUsedBytes.mockResolvedValue(4.9 * GB); // near the 5 GB combined limit

      await expect(entitlementService.assertStorageAvailable(USER_A, 1 * GB)).rejects.toThrow();
    });
  });
});
