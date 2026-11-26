/**
 * A feature check resolves the user's plan and features once, in one parallel round trip (it used to run the same plan
 * lookup twice, one query after another: about seven sequential queries per guarded request). The answers are unchanged.
 */
const mockUserFind = jest.fn();
const mockSubFind = jest.fn();
const mockOverrides = jest.fn();
const mockEnsure = jest.fn();

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => mockUserFind(...a) },
    subscription: { findUnique: (...a: unknown[]) => mockSubFind(...a) },
    featureEntitlement: { findMany: (...a: unknown[]) => mockOverrides(...a) },
  },
}));
jest.mock('../../src/services/subscription/subscription.service', () => ({
  subscriptionService: { ensureDefaultSubscription: (...a: unknown[]) => mockEnsure(...a) },
}));
jest.mock('../../src/services/subscription/usage/storage-usage.service', () => ({ storageUsageService: {} }));
jest.mock('../../src/services/subscription/usage/asset-quota.service', () => ({ assetQuotaService: {} }));

import { entitlementService, SubscriptionRequiredError } from '../../src/services/subscription/entitlements/entitlement.service';
import { FeatureKey } from '../../src/services/subscription/constants/features';
import { PLAN_DEFINITIONS, PlanCode } from '../../src/services/subscription/constants/plans';

const sub = (code: PlanCode, status = 'ACTIVE') => ({ status, plan: { code } });
const FEATURE: FeatureKey = FeatureKey.FEATURE_INVESTIGATION;
const planHas = (code: PlanCode, f: FeatureKey) => (PLAN_DEFINITIONS[code].features as FeatureKey[]).includes(f);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(entitlementService, 'isEnforcementEnabled').mockReturnValue(true);
  mockUserFind.mockResolvedValue({ role: 'USER' });
  mockSubFind.mockResolvedValue(sub(PlanCode.PRO));
  mockOverrides.mockResolvedValue([]);
  mockEnsure.mockResolvedValue(undefined);
});

describe('a feature check costs one round trip', () => {
  test('one user, one subscription and one overrides lookup, no repeats', async () => {
    await entitlementService.checkFeature('u1', FEATURE);
    expect(mockUserFind).toHaveBeenCalledTimes(1);
    expect(mockSubFind).toHaveBeenCalledTimes(1);
    expect(mockOverrides).toHaveBeenCalledTimes(1);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test('the guard path (assertFeature) is also a single round trip', async () => {
    await entitlementService.assertFeature('u1', FEATURE).catch(() => undefined);
    expect(mockUserFind).toHaveBeenCalledTimes(1);
    expect(mockSubFind).toHaveBeenCalledTimes(1);
  });

  test('the three lookups are issued together, not one after another', async () => {
    const order: string[] = [];
    mockUserFind.mockImplementation(async () => { order.push('user'); await new Promise((r) => setTimeout(r, 30)); order.push('user-done'); return { role: 'USER' }; });
    mockSubFind.mockImplementation(async () => { order.push('sub'); await new Promise((r) => setTimeout(r, 30)); order.push('sub-done'); return sub(PlanCode.PRO); });
    mockOverrides.mockImplementation(async () => { order.push('overrides'); await new Promise((r) => setTimeout(r, 30)); order.push('overrides-done'); return []; });
    await entitlementService.checkFeature('u1', FEATURE);
    expect(order.slice(0, 3).sort()).toEqual(['overrides', 'sub', 'user']); // all started before any finished
  });
});

describe('the answers are unchanged', () => {
  test('a plan grants what its definition lists', async () => {
    mockSubFind.mockResolvedValue(sub(PlanCode.PRO));
    const r = await entitlementService.checkFeature('u1', FEATURE);
    expect(r.planCode).toBe(PlanCode.PRO);
    expect(r.allowed).toBe(planHas(PlanCode.PRO, FEATURE));
  });

  test('an admin gets ENTERPRISE without a subscription row being created', async () => {
    mockUserFind.mockResolvedValue({ role: 'ADMIN' });
    mockSubFind.mockResolvedValue(null);
    const r = await entitlementService.checkFeature('admin', FEATURE);
    expect(r.planCode).toBe(PlanCode.ENTERPRISE);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test('a user with no subscription gets one created, then is read again', async () => {
    mockSubFind.mockResolvedValueOnce(null).mockResolvedValueOnce(sub(PlanCode.FREE));
    const r = await entitlementService.checkFeature('new-user', FEATURE);
    expect(mockEnsure).toHaveBeenCalledWith('new-user');
    expect(mockSubFind).toHaveBeenCalledTimes(2);
    expect(r.planCode).toBe(PlanCode.FREE);
  });

  test.each(['CANCELED', 'EXPIRED'])('a %s subscription means the FREE plan', async (status) => {
    mockSubFind.mockResolvedValue(sub(PlanCode.PRO, status));
    expect((await entitlementService.checkFeature('u1', FEATURE)).planCode).toBe(PlanCode.FREE);
  });

  test('an unknown plan code falls back to FREE', async () => {
    mockSubFind.mockResolvedValue(sub('NOT_A_PLAN' as PlanCode));
    expect((await entitlementService.checkFeature('u1', FEATURE)).planCode).toBe(PlanCode.FREE);
  });

  test('a per-user override can switch a feature on or off', async () => {
    mockSubFind.mockResolvedValue(sub(PlanCode.FREE));
    mockOverrides.mockResolvedValue([{ featureKey: FEATURE, enabled: true }]);
    expect((await entitlementService.checkFeature('u1', FEATURE)).allowed).toBe(true);
    mockSubFind.mockResolvedValue(sub(PlanCode.ENTERPRISE));
    mockOverrides.mockResolvedValue([{ featureKey: FEATURE, enabled: false }]);
    expect((await entitlementService.checkFeature('u1', FEATURE)).allowed).toBe(false);
  });

  test('assertFeature throws when the feature is not granted', async () => {
    mockSubFind.mockResolvedValue(sub(PlanCode.FREE));
    mockOverrides.mockResolvedValue([{ featureKey: FEATURE, enabled: false }]);
    await expect(entitlementService.assertFeature('u1', FEATURE)).rejects.toBeInstanceOf(SubscriptionRequiredError);
  });

  test('with enforcement off, everything is allowed and nothing is looked up by hasFeature', async () => {
    (entitlementService.isEnforcementEnabled as jest.Mock).mockReturnValue(false);
    expect(await entitlementService.hasFeature('u1', FEATURE)).toBe(true);
    expect(mockUserFind).not.toHaveBeenCalled();
  });
});
