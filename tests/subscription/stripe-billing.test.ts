/**
 * Stripe billing — Checkout Session creation, webhook signature
 * verification, and fulfilment, plus isolation from Razorpay's config and
 * pricing. No live Stripe calls: the `stripe` SDK and prisma are both
 * mocked, same pattern as razorpay-billing.test.ts.
 */
import { describe, test, beforeEach, expect, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSessionsCreate = jest.fn<() => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockConstructEvent = jest.fn<(...args: any[]) => any>();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionsCreate } },
    webhooks: { constructEvent: mockConstructEvent },
  }));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncMock = jest.Mock<(...args: any[]) => Promise<any>>;
function asyncMock(): AsyncMock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest.fn<() => Promise<any>>() as unknown as AsyncMock;
}

const mockPrisma = {
  subscription: { findUnique: asyncMock(), update: asyncMock() },
  billingHistory: { create: asyncMock(), findFirst: asyncMock(), update: asyncMock() },
  plan: { findUnique: asyncMock() },
  storageGrant: { create: asyncMock() },
  featureEntitlement: { upsert: asyncMock() },
  $transaction: jest.fn(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma)),
};

jest.mock('../../src/lib/prisma', () => ({ prisma: mockPrisma }));

jest.mock('../../src/services/subscription/subscription.service', () => ({
  subscriptionService: {
    ensureDefaultSubscription: jest.fn(async () => undefined),
    assignPlan: jest.fn(async () => undefined),
  },
}));

import { config } from '../../src/config';
import { PlanCode, PLAN_DEFINITIONS } from '../../src/services/subscription/constants/plans';

// `config` is typed `as const` for production code; this test-only alias
// drops that restriction so these tests can simulate different env states.
const mutableConfig = config as unknown as {
  hub: { appUrl: string };
  razorpay: { keyId: string; keySecret: string; webhookSecret: string };
  stripe: { secretKey: string; webhookSecret: string; testPriceOverrideEnabled: boolean; testProPriceCents: number; testProStorageGb: number; testCurrency: string };
  subscription: { testPriceOverrideEnabled: boolean; testProPricePaise: number; testProStorageGb: number };
};

import { stripeBillingService, verifyAndParseStripeWebhook, isStripeConfigured } from '../../src/services/subscription/billing/stripe.service';
import { resolveEffectivePlan } from '../../src/services/subscription/constants/plans';
import { resolveEffectiveStripePrice } from '../../src/services/subscription/constants/stripe-plans';

const USER_A = 'user-a-uuid';
const SUB_A = { id: 'sub-a-id', userId: USER_A };

describe('stripeBillingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutableConfig.stripe.secretKey = 'sk_test_fixture';
    mutableConfig.stripe.webhookSecret = 'whsec_fixture';
    mutableConfig.stripe.testPriceOverrideEnabled = true;
    mutableConfig.stripe.testProPriceCents = 100;
    mutableConfig.stripe.testProStorageGb = 3;
    mutableConfig.stripe.testCurrency = 'usd';
    mutableConfig.hub.appUrl = 'https://hub.example.com';
    // Razorpay's own override must be able to differ independently — most
    // tests leave it off to prove the two providers don't share state.
    mutableConfig.subscription.testPriceOverrideEnabled = false;
    mutableConfig.subscription.testProPricePaise = 0;
    mutableConfig.subscription.testProStorageGb = 0;
    mockPrisma.plan.findUnique.mockResolvedValue({ id: 'plan-pro-id', code: 'PRO' });
    mockPrisma.storageGrant.create.mockResolvedValue({ id: 'grant-id' });
    mockPrisma.featureEntitlement.upsert.mockResolvedValue({ id: 'fe-id' });
  });

  describe('createCheckoutSession', () => {
    test('charges the server-authoritative test price, not a client-supplied one', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_stripe_1' });
      mockSessionsCreate.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/cs_test_1' });

      const result = await stripeBillingService.createCheckoutSession(USER_A, PlanCode.PRO);

      expect(mockSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'payment',
          line_items: [expect.objectContaining({
            price_data: expect.objectContaining({ currency: 'usd', unit_amount: 100 }),
          })],
        }),
      );
      expect(result.amountCents).toBe(100);
      expect(result.billingId).toBe('bh_stripe_1');
      expect(mockPrisma.billingHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amountCents: 100, provider: 'STRIPE', externalId: 'cs_test_1' }) }),
      );
    });

    test('builds success/cancel URLs server-side from config.hub.appUrl, never from client input', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_stripe_url' });
      mockSessionsCreate.mockResolvedValue({ id: 'cs_test_url', url: 'https://checkout.stripe.com/cs_test_url' });

      await stripeBillingService.createCheckoutSession(USER_A, PlanCode.PRO);

      const call = mockSessionsCreate.mock.calls[0][0] as { success_url: string; cancel_url: string };
      expect(call.success_url.startsWith('https://hub.example.com/')).toBe(true);
      expect(call.cancel_url.startsWith('https://hub.example.com/')).toBe(true);
    });

    test('FREE plan cannot be purchased', async () => {
      await expect(stripeBillingService.createCheckoutSession(USER_A, PlanCode.FREE)).rejects.toThrow();
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });

    test('refuses to create a session when no price is configured at all (override off)', async () => {
      mutableConfig.stripe.testPriceOverrideEnabled = false;
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(stripeBillingService.createCheckoutSession(USER_A, PlanCode.PRO)).rejects.toThrow(/no stripe price is configured/i);
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });

    test('refuses the override against a live key, even for session creation', async () => {
      mutableConfig.stripe.secretKey = 'sk_live_real';
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(stripeBillingService.createCheckoutSession(USER_A, PlanCode.PRO)).rejects.toThrow();
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });

    test('a Stripe-side rejection surfaces as 502, not a silent failure, and writes no billing row', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockSessionsCreate.mockRejectedValue({ type: 'StripeInvalidRequestError', message: 'No such price' });

      await expect(stripeBillingService.createCheckoutSession(USER_A, PlanCode.PRO)).rejects.toThrow(/could not create the checkout session/i);
      expect(mockPrisma.billingHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('webhook signature verification', () => {
    test('rejects when the configured webhook secret is missing', () => {
      mutableConfig.stripe.webhookSecret = '';
      const event = verifyAndParseStripeWebhook(Buffer.from('{}'), 'some-signature');
      expect(event).toBeNull();
      expect(mockConstructEvent).not.toHaveBeenCalled();
    });

    test('rejects a missing signature header even with a secret configured', () => {
      const event = verifyAndParseStripeWebhook(Buffer.from('{}'), undefined);
      expect(event).toBeNull();
      expect(mockConstructEvent).not.toHaveBeenCalled();
    });

    test('rejects when the SDK throws on an invalid signature', () => {
      mockConstructEvent.mockImplementation(() => { throw new Error('No signatures found matching the expected signature'); });
      const event = verifyAndParseStripeWebhook(Buffer.from('{}'), 'wrong-sig');
      expect(event).toBeNull();
    });

    test('returns the parsed event when the SDK verifies successfully', () => {
      const fakeEvent = { id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } };
      mockConstructEvent.mockReturnValue(fakeEvent);
      const event = verifyAndParseStripeWebhook(Buffer.from('{}'), 'good-sig');
      expect(event).toEqual(fakeEvent);
    });
  });

  describe('activateFromWebhookSession (checkout.session.completed)', () => {
    function paidSession(overrides: Record<string, unknown> = {}) {
      return {
        id: 'cs_test_2',
        payment_status: 'paid',
        amount_total: 100,
        currency: 'usd',
        payment_intent: 'pi_test_2',
        ...overrides,
      } as never;
    }

    test('activates a PENDING session on first delivery', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_2', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO', userId: USER_A }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidSession());

      expect(result.handled).toBe(true);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.billingHistory.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'bh_2' }, data: expect.objectContaining({ status: 'SUCCEEDED' }) }),
      );
    });

    test('Permanent entitlements: creates a StorageGrant and unlocks every PRO feature', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_3', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO', userId: USER_A }, subscription: SUB_A,
      });

      await stripeBillingService.activateFromWebhookSession(paidSession({ id: 'cs_test_3' }));

      expect(mockPrisma.storageGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: USER_A, type: 'PURCHASED', billingHistoryId: 'bh_3' }) }),
      );
      const proFeatures = PLAN_DEFINITIONS.PRO.features;
      expect(mockPrisma.featureEntitlement.upsert).toHaveBeenCalledTimes(proFeatures.length);
    });

    test('a duplicate grant attempt for the same session is swallowed (unique-constraint race), not a crash', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_race', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO', userId: USER_A }, subscription: SUB_A,
      });
      const uniqueViolation = Object.assign(new Error('Unique constraint failed on billingHistoryId'), { code: 'P2002' });
      mockPrisma.storageGrant.create.mockRejectedValueOnce(uniqueViolation);

      await expect(stripeBillingService.activateFromWebhookSession(paidSession({ id: 'cs_race' })))
        .resolves.toMatchObject({ handled: true });
    });

    test('an unpaid/incomplete session grants nothing', async () => {
      const result = await stripeBillingService.activateFromWebhookSession(paidSession({ payment_status: 'unpaid' }));
      expect(result.handled).toBe(false);
      expect(mockPrisma.billingHistory.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('duplicate webhook delivery for an already-SUCCEEDED session is a no-op', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_4', status: 'SUCCEEDED', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO' }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidSession({ id: 'cs_test_4' }));

      expect(result.handled).toBe(true);
      expect(result.reason).toBe('already_processed');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('a session for an unrecognized id is ignored, not acted on (no user to misattribute to)', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue(null);

      const result = await stripeBillingService.activateFromWebhookSession(paidSession({ id: 'cs_never_created' }));

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('unknown_session');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('out-of-order delivery guard: a FAILED session is never flipped to SUCCEEDED by a late event', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_5', status: 'FAILED', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO' }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidSession({ id: 'cs_test_5' }));

      expect(result.handled).toBe(false);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('amount mismatch between the session and the original order is refused', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_6', status: 'PENDING', amountCents: 99900, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO' }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidSession({ id: 'cs_test_6', amount_total: 1 }));

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('amount_mismatch');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('currency mismatch between the session and the original order is refused', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_7', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO' }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidSession({ id: 'cs_test_7', currency: 'eur' }));

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('currency_mismatch');
    });

    test('a database failure during activation propagates rather than returning a false success', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_dbfail', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO' }, subscription: SUB_A,
      });
      mockPrisma.$transaction.mockRejectedValueOnce(new Error('connection to database lost'));

      await expect(stripeBillingService.activateFromWebhookSession(paidSession({ id: 'cs_dbfail' })))
        .rejects.toThrow(/connection to database lost/);
    });
  });

  describe('markWebhookSessionFailed (checkout.session.expired)', () => {
    test('marks a PENDING session FAILED and grants nothing', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_expired', status: 'PENDING', amountCents: 100, currency: 'USD', rawPayload: {},
      });

      const result = await stripeBillingService.markWebhookSessionFailed({ sessionId: 'cs_expired', reason: 'expired' });

      expect(result.handled).toBe(true);
      expect(mockPrisma.billingHistory.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'bh_expired' }, data: expect.objectContaining({ status: 'FAILED' }) }),
      );
      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
      expect(mockPrisma.featureEntitlement.upsert).not.toHaveBeenCalled();
    });

    test('never flips an already-SUCCEEDED session to FAILED', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_succ', status: 'SUCCEEDED', amountCents: 100, currency: 'USD', rawPayload: {},
      });

      const result = await stripeBillingService.markWebhookSessionFailed({ sessionId: 'cs_succ' });

      expect(result.handled).toBe(true);
      expect(result.reason).toBe('already_terminal');
      expect(mockPrisma.billingHistory.update).not.toHaveBeenCalled();
    });
  });

  describe('public config never leaks the secret', () => {
    test('getPublicConfig exposes no secret key', () => {
      mutableConfig.stripe.secretKey = 'super-secret-value-must-not-leak';
      const publicConfig = stripeBillingService.getPublicConfig();
      const serialized = JSON.stringify(publicConfig);
      expect(serialized).not.toContain('super-secret-value-must-not-leak');
      expect(publicConfig).not.toHaveProperty('secretKey');
      expect(publicConfig).not.toHaveProperty('webhookSecret');
    });

    test('isStripeConfigured is false without both a secret key and a webhook secret', () => {
      mutableConfig.stripe.secretKey = '';
      mutableConfig.stripe.webhookSecret = '';
      expect(isStripeConfigured()).toBe(false);
    });
  });

  describe('isolation between Stripe and Razorpay', () => {
    test('enabling the Stripe test override does not change what Razorpay charges for PRO', () => {
      mutableConfig.stripe.testPriceOverrideEnabled = true;
      mutableConfig.stripe.testProPriceCents = 100;
      mutableConfig.subscription.testPriceOverrideEnabled = false;

      const razorpayPlan = resolveEffectivePlan(PlanCode.PRO);
      expect(razorpayPlan.pricePaise).toBe(PLAN_DEFINITIONS.PRO.pricePaise);
      expect(razorpayPlan.priceInr).toBe(PLAN_DEFINITIONS.PRO.priceInr);
    });

    test('enabling the Razorpay test override does not change what Stripe would charge', async () => {
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testProPricePaise = 1000;
      mutableConfig.subscription.testProStorageGb = 3;
      // Stripe's own override stays off in this test — createCheckoutSession
      // must still refuse (no Stripe price configured), proving Razorpay's
      // override enabling itself did not also enable Stripe's.
      mutableConfig.stripe.testPriceOverrideEnabled = false;
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(stripeBillingService.createCheckoutSession(USER_A, PlanCode.PRO)).rejects.toThrow(/no stripe price is configured/i);
    });

    test('a live Razorpay key does not trip Stripe\'s own live-key safety check', () => {
      mutableConfig.razorpay.keyId = 'rzp_live_real';
      mutableConfig.stripe.secretKey = 'sk_test_fixture';
      mutableConfig.stripe.testPriceOverrideEnabled = true;
      mutableConfig.stripe.testProPriceCents = 100;
      mutableConfig.stripe.testProStorageGb = 3;

      // Resolves fine — Stripe's own safety check only looks at Stripe's own key, not Razorpay's.
      expect(() => resolveEffectiveStripePrice(PlanCode.PRO)).not.toThrow();
    });

    test('a live Stripe key refuses the Stripe override regardless of Razorpay\'s key', () => {
      mutableConfig.razorpay.keyId = 'rzp_test_fixture';
      mutableConfig.stripe.secretKey = 'sk_live_real';
      mutableConfig.stripe.testPriceOverrideEnabled = true;
      mutableConfig.stripe.testProPriceCents = 100;
      mutableConfig.stripe.testProStorageGb = 3;

      expect(() => resolveEffectiveStripePrice(PlanCode.PRO)).toThrow();
    });
  });
});
