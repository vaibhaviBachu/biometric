/**
 * Free plan: limited by storage only (2 GB), never by how many assets are protected.
 * Upgrade: Pro, ₹999 per month, 50 GB.
 */
import { PLAN_DEFINITIONS, PlanCode } from '../../src/services/subscription/constants/plans';
import { entitlementService, storageUsageService, StorageLimitError } from '../../src/services/subscription';
import { assetQuotaService } from '../../src/services/subscription/usage/asset-quota.service';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe('Free plan is storage-only', () => {
  afterEach(() => jest.restoreAllMocks());

  it('has a 2 GB storage limit and no asset-count limit', () => {
    expect(PLAN_DEFINITIONS.FREE.storageLimitBytes).toBe(2 * GB);
    expect(PLAN_DEFINITIONS.FREE.assetLimit).toBeNull();
  });

  it('the next plan is Pro: ₹999 per month for 50 GB', () => {
    expect(PLAN_DEFINITIONS.PRO.priceInr).toBe(999);
    expect(PLAN_DEFINITIONS.PRO.pricePaise).toBe(99900);
    expect(PLAN_DEFINITIONS.PRO.storageLimitBytes).toBe(50 * GB);
    expect(PLAN_DEFINITIONS.PRO.assetLimit).toBeNull();
  });

  it('a free user with many assets is not stopped by the asset count', async () => {
    jest.spyOn(entitlementService, 'isEnforcementEnabled').mockReturnValue(true);
    jest.spyOn(entitlementService, 'getEffectivePlanCode').mockResolvedValue(PlanCode.FREE);
    const count = jest.spyOn(assetQuotaService, 'getProtectedAssetCount').mockResolvedValue(500);
    await expect(entitlementService.assertCanProtectAsset('u1')).resolves.toBeUndefined();
    expect(count).not.toHaveBeenCalled(); // no limit, so the count is not even read
  });

  it('a free user with 500 small assets can still protect more while storage remains', async () => {
    jest.spyOn(entitlementService, 'isEnforcementEnabled').mockReturnValue(true);
    jest.spyOn(entitlementService, 'getEffectivePlanCode').mockResolvedValue(PlanCode.FREE);
    // Phase 1B: getStorageLimitBytes now also sums trial/purchased grants (see
    // tests/subscription/storage-entitlements.test.ts for that mechanism in
    // isolation) — this test is about assertCanUpload's threshold logic given
    // a limit, so the limit itself is supplied directly, same convention as
    // asset-upload-storage-policy.test.ts.
    jest.spyOn(entitlementService, 'getStorageLimitBytes').mockResolvedValue(2 * GB);
    jest.spyOn(storageUsageService, 'getUsedBytes').mockResolvedValue(300 * MB);
    await expect(entitlementService.assertCanUpload('u1', 20 * MB)).resolves.toBeUndefined();
  });

  it('is stopped only when the file would not fit in the 2 GB, and is pointed at Pro', async () => {
    jest.spyOn(entitlementService, 'isEnforcementEnabled').mockReturnValue(true);
    jest.spyOn(entitlementService, 'getEffectivePlanCode').mockResolvedValue(PlanCode.FREE);
    jest.spyOn(entitlementService, 'getStorageLimitBytes').mockResolvedValue(2 * GB);
    jest.spyOn(storageUsageService, 'getUsedBytes').mockResolvedValue(2 * GB - 5 * MB);
    const err = await entitlementService.assertCanUpload('u1', 20 * MB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageLimitError);
    expect((err as StorageLimitError).requiredPlan).toBe(PlanCode.PRO);
    expect((err as StorageLimitError).limitBytes).toBe(2 * GB);
  });
});
