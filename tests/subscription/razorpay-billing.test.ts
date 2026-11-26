/**
 * Phase 1 Razorpay billing — order creation, signature verification,
 * the user/order-binding security fix, and webhook reconciliation.
 *
 * No live Razorpay calls: the `razorpay` SDK and prisma are both mocked.
 */
import crypto from 'crypto';
import { describe, test, beforeEach, expect, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOrdersCreate = jest.fn<() => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPaymentsFetch = jest.fn<() => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQrCodeCreate = jest.fn<() => Promise<any>>();

jest.mock('razorpay', () => {
  return jest.fn().mockImplementation(() => ({
    orders: { create: mockOrdersCreate },
    payments: { fetch: mockPaymentsFetch },
    qrCode: { create: mockQrCodeCreate },
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

// `config` is typed `as const` (deeply readonly) for production code; this
// test-only alias is the same underlying object, just without that type
// restriction, so these tests can simulate different env states.
const mutableConfig = config as unknown as {
  env: string;
  razorpay: { keyId: string; keySecret: string; webhookSecret: string };
  subscription: {
    testPriceOverrideEnabled: boolean;
    testProPricePaise: number;
    testProStorageGb: number;
    testStorageTopUpPricePaisePerGb: number;
  };
};
import {
  razorpayBillingService,
  verifyRazorpayWebhookSignature,
  isMockBillingAllowed,
} from '../../src/services/subscription/billing/razorpay.service';
import { subscriptionService } from '../../src/services/subscription/subscription.service';
import { StoragePackCode } from '../../src/services/subscription/constants/storage-packs';

const GB = 1024 * 1024 * 1024;

const USER_A = 'user-a-uuid';
const USER_B = 'user-b-uuid';
const SUB_A = { id: 'sub-a-id', userId: USER_A };
const SUB_B = { id: 'sub-b-id', userId: USER_B };

function sign(orderId: string, paymentId: string, secret = config.razorpay.keySecret): string {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

describe('razorpayBillingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutableConfig.razorpay.keyId = 'rzp_test_fixture';
    mutableConfig.razorpay.keySecret = 'test_secret_fixture';
    mutableConfig.razorpay.webhookSecret = 'webhook_secret_fixture';
    mutableConfig.subscription.testPriceOverrideEnabled = false;
    mutableConfig.subscription.testProPricePaise = 0;
    mutableConfig.subscription.testProStorageGb = 0;
    mutableConfig.subscription.testStorageTopUpPricePaisePerGb = 0;
    mockPrisma.plan.findUnique.mockResolvedValue({ id: 'plan-pro-id', code: 'PRO' });
    mockPrisma.storageGrant.create.mockResolvedValue({ id: 'grant-id' });
    mockPrisma.featureEntitlement.upsert.mockResolvedValue({ id: 'fe-id' });
  });

  describe('createOrder', () => {
    test('charges the server-authoritative amount (real plan, override off)', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockOrdersCreate.mockResolvedValue({ id: 'order_real1', amount: 99900, currency: 'INR' });

      const result = await razorpayBillingService.createOrder(USER_A, PlanCode.PRO);

      expect(mockOrdersCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 99900, currency: 'INR' }),
      );
      expect(result.priceInr).toBe(999);
      expect(mockPrisma.billingHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amountCents: 99900 }) }),
      );
    });

    test('charges the test-price override when active (₹10 / 3 GB)', async () => {
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testProPricePaise = 1000;
      mutableConfig.subscription.testProStorageGb = 3;
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockOrdersCreate.mockResolvedValue({ id: 'order_test1', amount: 1000, currency: 'INR' });

      const result = await razorpayBillingService.createOrder(USER_A, PlanCode.PRO);

      expect(mockOrdersCreate).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000 }));
      expect(result.priceInr).toBe(10);
      expect(result.storageLimitBytes).toBe(3 * 1024 * 1024 * 1024);
    });

    test('refuses the override against a live key, even for order creation', async () => {
      mutableConfig.razorpay.keyId = 'rzp_live_real';
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testProPricePaise = 1000;
      mutableConfig.subscription.testProStorageGb = 3;
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(razorpayBillingService.createOrder(USER_A, PlanCode.PRO)).rejects.toThrow();
      expect(mockOrdersCreate).not.toHaveBeenCalled();
    });

    test('FREE plan cannot be purchased', async () => {
      await expect(razorpayBillingService.createOrder(USER_A, PlanCode.FREE)).rejects.toThrow();
      expect(mockOrdersCreate).not.toHaveBeenCalled();
    });
  });

  describe('createStorageTopUpOrder — Razorpay/INR counterpart to Stripe storage top-ups', () => {
    test('charges the test-price override and records purchaseType + bytesGranted on the billing row', async () => {
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testStorageTopUpPricePaisePerGb = 4000;
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockOrdersCreate.mockResolvedValue({ id: 'order_topup1', amount: 8000, currency: 'INR' });
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_topup1' });

      const result = await razorpayBillingService.createStorageTopUpOrder(USER_A, StoragePackCode.GB_2);

      expect(mockOrdersCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 8000, currency: 'INR' }),
      );
      expect(result).toMatchObject({ orderId: 'order_topup1', bytesGranted: 2 * GB, currency: 'INR' });
      expect(mockPrisma.billingHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amountCents: 8000,
            provider: 'RAZORPAY',
            rawPayload: expect.objectContaining({
              purchaseType: 'storage_topup',
              packCode: StoragePackCode.GB_2,
              bytesGranted: 2 * GB,
            }),
          }),
        }),
      );
    });

    test('refuses when no Razorpay storage top-up price is configured', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      await expect(
        razorpayBillingService.createStorageTopUpOrder(USER_A, StoragePackCode.GB_1),
      ).rejects.toThrow(/is configured yet/i);
      expect(mockOrdersCreate).not.toHaveBeenCalled();
    });

    test('refuses the override against a live key', async () => {
      mutableConfig.razorpay.keyId = 'rzp_live_real';
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testStorageTopUpPricePaisePerGb = 4000;
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(
        razorpayBillingService.createStorageTopUpOrder(USER_A, StoragePackCode.GB_1),
      ).rejects.toThrow();
      expect(mockOrdersCreate).not.toHaveBeenCalled();
    });
  });

  describe('verifyAndActivate — signature and binding', () => {
    test('rejects an invalid signature before touching the database', async () => {
      await expect(
        razorpayBillingService.verifyAndActivate({
          userId: USER_A,
          planCode: PlanCode.PRO,
          razorpayOrderId: 'order_1',
          razorpayPaymentId: 'pay_1',
          razorpaySignature: 'not-a-real-signature',
        }),
      ).rejects.toThrow(/signature/i);

      expect(mockPrisma.billingHistory.findFirst).not.toHaveBeenCalled();
    });

    test('SECURITY: a valid signature for an order belonging to a DIFFERENT user is refused, not activated', async () => {
      // Attacker: authenticated as USER_B, replays USER_A's real order_id +
      // payment_id + signature (all three travel through the browser and are
      // not secret — the signature alone does not bind them to a user).
      const orderId = 'order_belongs_to_A';
      const paymentId = 'pay_belongs_to_A';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_B);
      // USER_B's own subscription has no billingHistory row for USER_A's order:
      mockPrisma.billingHistory.findFirst.mockResolvedValue(null);

      await expect(
        razorpayBillingService.verifyAndActivate({
          userId: USER_B,
          planCode: PlanCode.PRO,
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
        }),
      ).rejects.toThrow(/does not correspond to a known order/i);

      // The old vulnerable behavior created a row and activated here — assert it does not:
      expect(mockPrisma.billingHistory.create).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPaymentsFetch).not.toHaveBeenCalled();
    });

    test('rejects when the captured amount does not match the order amount', async () => {
      const orderId = 'order_2';
      const paymentId = 'pay_2';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_2', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({
        order_id: orderId, status: 'captured', amount: 1, currency: 'INR', // tampered/wrong amount
      });

      await expect(
        razorpayBillingService.verifyAndActivate({
          userId: USER_A, planCode: PlanCode.PRO,
          razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
        }),
      ).rejects.toThrow(/amount/i);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('rejects a payment that is authorized but not yet captured', async () => {
      const orderId = 'order_3';
      const paymentId = 'pay_3';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_3', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'authorized', amount: 99900, currency: 'INR' });

      await expect(
        razorpayBillingService.verifyAndActivate({
          userId: USER_A, planCode: PlanCode.PRO,
          razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
        }),
      ).rejects.toThrow(/not captured/i);
    });

    test('activates on a genuinely valid, matching, captured payment', async () => {
      const orderId = 'order_4';
      const paymentId = 'pay_4';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_4', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'captured', amount: 99900, currency: 'INR' });

      const result = await razorpayBillingService.verifyAndActivate({
        userId: USER_A, planCode: PlanCode.PRO,
        razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
      });

      expect(result.alreadyProcessed).toBe(false);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.billingHistory.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'bh_4' }, data: expect.objectContaining({ status: 'SUCCEEDED' }) }),
      );
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER_A } }),
      );
    });

    test('Phase 1B: activation creates a permanent StorageGrant tied to this exact payment', async () => {
      mutableConfig.subscription.testPriceOverrideEnabled = true;
      mutableConfig.subscription.testProPricePaise = 1000;
      mutableConfig.subscription.testProStorageGb = 3;
      const orderId = 'order_4b';
      const paymentId = 'pay_4b';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_4b', status: 'PENDING', amountCents: 1000, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'captured', amount: 1000, currency: 'INR' });

      await razorpayBillingService.verifyAndActivate({
        userId: USER_A, planCode: PlanCode.PRO,
        razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
      });

      expect(mockPrisma.storageGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: USER_A,
            type: 'PURCHASED',
            bytesGranted: BigInt(3 * 1024 * 1024 * 1024),
            billingHistoryId: 'bh_4b',
          }),
        }),
      );
    });

    test('Phase 1B: a race that double-creates the grant for the same payment is swallowed, not a crash', async () => {
      const orderId = 'order_4c';
      const paymentId = 'pay_4c';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_4c', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'captured', amount: 99900, currency: 'INR' });
      const uniqueViolation = Object.assign(new Error('Unique constraint failed on billingHistoryId'), { code: 'P2002' });
      mockPrisma.storageGrant.create.mockRejectedValueOnce(uniqueViolation);

      await expect(
        razorpayBillingService.verifyAndActivate({
          userId: USER_A, planCode: PlanCode.PRO,
          razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
        }),
      ).resolves.toMatchObject({ alreadyProcessed: false });
    });

    test('Phase 1C: a verified PRO purchase permanently unlocks every PRO feature via FeatureEntitlement', async () => {
      const orderId = 'order_4d';
      const paymentId = 'pay_4d';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_4d', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'captured', amount: 99900, currency: 'INR' });

      await razorpayBillingService.verifyAndActivate({
        userId: USER_A, planCode: PlanCode.PRO,
        razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
      });

      const proFeatures = PLAN_DEFINITIONS.PRO.features;
      expect(proFeatures.length).toBeGreaterThan(0);
      expect(mockPrisma.featureEntitlement.upsert).toHaveBeenCalledTimes(proFeatures.length);
      for (const featureKey of proFeatures) {
        expect(mockPrisma.featureEntitlement.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { userId_featureKey: { userId: USER_A, featureKey } },
            create: expect.objectContaining({ userId: USER_A, featureKey, enabled: true }),
            update: { enabled: true },
          }),
        );
      }
    });

    test('Phase 1C: feature unlock is idempotent — a repeat purchase just re-asserts enabled, never duplicates', async () => {
      const orderId = 'order_4e';
      const paymentId = 'pay_4e';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_4e', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'captured', amount: 99900, currency: 'INR' });

      await razorpayBillingService.verifyAndActivate({
        userId: USER_A, planCode: PlanCode.PRO,
        razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
      });

      // upsert (not create) is itself the guarantee: calling it again for
      // the same userId+featureKey can never produce a duplicate row —
      // it is backed by the pre-existing @@unique([userId, featureKey]).
      expect(mockPrisma.featureEntitlement.upsert).toHaveBeenCalled();
      const firstCallArgs = mockPrisma.featureEntitlement.upsert.mock.calls[0][0];
      expect(firstCallArgs).toMatchObject({ update: { enabled: true } });
    });

    test('Phase 1C: duplicate verification of an already-SUCCEEDED purchase never re-touches FeatureEntitlement', async () => {
      const orderId = 'order_4f';
      const paymentId = 'pay_4f';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_4f', status: 'SUCCEEDED', amountCents: 99900, currency: 'INR', rawPayload: {},
      });

      await razorpayBillingService.verifyAndActivate({
        userId: USER_A, planCode: PlanCode.PRO,
        razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
      });

      expect(mockPrisma.featureEntitlement.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('duplicate verification of an already-SUCCEEDED order is idempotent — no second transaction', async () => {
      const orderId = 'order_5';
      const paymentId = 'pay_5';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_5', status: 'SUCCEEDED', amountCents: 99900, currency: 'INR', rawPayload: {},
      });

      const result = await razorpayBillingService.verifyAndActivate({
        userId: USER_A, planCode: PlanCode.PRO,
        razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
      });

      expect(result.alreadyProcessed).toBe(true);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(subscriptionService.assignPlan).toHaveBeenCalledWith(USER_A, PlanCode.PRO);
      expect(mockPaymentsFetch).not.toHaveBeenCalled();
    });
  });

  describe('webhook reconciliation (payment.captured)', () => {
    test('rejects a webhook with an invalid signature', () => {
      const ok = verifyRazorpayWebhookSignature(Buffer.from('{"event":"payment.captured"}'), 'wrong-signature');
      expect(ok).toBe(false);
    });

    test('accepts a webhook whose signature matches the raw body', () => {
      const raw = Buffer.from('{"event":"payment.captured"}');
      const sig = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(raw).digest('hex');
      expect(verifyRazorpayWebhookSignature(raw, sig)).toBe(true);
    });

    test('activates a PENDING order on first delivery', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_6', status: 'PENDING', amountCents: 1000, currency: 'INR',
        subscriptionId: SUB_A.id,
        rawPayload: { planCode: 'PRO', userId: USER_A },
        subscription: SUB_A,
      });

      const result = await razorpayBillingService.activateFromWebhookCapture({
        orderId: 'order_w1', paymentId: 'pay_w1', amountCaptured: 1000, currency: 'INR',
      });

      expect(result.handled).toBe(true);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    test('Phase 1C: webhook-driven activation also permanently unlocks PRO features', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_6b', status: 'PENDING', amountCents: 1000, currency: 'INR',
        subscriptionId: SUB_A.id,
        rawPayload: { planCode: 'PRO', userId: USER_A },
        subscription: SUB_A,
      });

      await razorpayBillingService.activateFromWebhookCapture({
        orderId: 'order_w1b', paymentId: 'pay_w1b', amountCaptured: 1000, currency: 'INR',
      });

      expect(mockPrisma.featureEntitlement.upsert).toHaveBeenCalledTimes(PLAN_DEFINITIONS.PRO.features.length);
    });

    test('duplicate webhook delivery for an already-SUCCEEDED order is a no-op', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_7', status: 'SUCCEEDED', amountCents: 1000, currency: 'INR',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO' }, subscription: SUB_A,
      });

      const result = await razorpayBillingService.activateFromWebhookCapture({
        orderId: 'order_w2', paymentId: 'pay_w2', amountCaptured: 1000, currency: 'INR',
      });

      expect(result.handled).toBe(true);
      expect(result.reason).toBe('already_processed');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('webhook for an unknown order_id is logged and ignored, not acted on', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue(null);

      const result = await razorpayBillingService.activateFromWebhookCapture({
        orderId: 'order_never_created', paymentId: 'pay_x', amountCaptured: 1000, currency: 'INR',
      });

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('unknown_order');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('out-of-order delivery guard: a FAILED row is never flipped to SUCCEEDED by a late capture event', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_8', status: 'FAILED', amountCents: 1000, currency: 'INR',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO' }, subscription: SUB_A,
      });

      const result = await razorpayBillingService.activateFromWebhookCapture({
        orderId: 'order_w3', paymentId: 'pay_w3', amountCaptured: 1000, currency: 'INR',
      });

      expect(result.handled).toBe(false);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('amount mismatch between webhook and the original order is refused', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_9', status: 'PENDING', amountCents: 99900, currency: 'INR',
        subscriptionId: SUB_A.id, rawPayload: { planCode: 'PRO' }, subscription: SUB_A,
      });

      const result = await razorpayBillingService.activateFromWebhookCapture({
        orderId: 'order_w4', paymentId: 'pay_w4', amountCaptured: 1, currency: 'INR',
      });

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('amount_mismatch');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('webhook reconciliation (payment.failed) — no entitlements on a failed payment', () => {
    test('marks a PENDING order FAILED and grants nothing', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_fail1', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });

      const result = await razorpayBillingService.markWebhookPaymentFailed({
        orderId: 'order_fail1', paymentId: 'pay_fail1', errorDescription: 'Card declined',
      });

      expect(result.handled).toBe(true);
      expect(mockPrisma.billingHistory.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'bh_fail1' }, data: expect.objectContaining({ status: 'FAILED' }) }),
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
      expect(mockPrisma.featureEntitlement.upsert).not.toHaveBeenCalled();
    });

    test('never flips an already-SUCCEEDED order to FAILED', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_fail2', status: 'SUCCEEDED', amountCents: 99900, currency: 'INR', rawPayload: {},
      });

      const result = await razorpayBillingService.markWebhookPaymentFailed({
        orderId: 'order_fail2', paymentId: 'pay_fail2',
      });

      expect(result.handled).toBe(true);
      expect(result.reason).toBe('already_terminal');
      expect(mockPrisma.billingHistory.update).not.toHaveBeenCalled();
    });

    test('an unknown order_id is ignored, not acted on', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue(null);

      const result = await razorpayBillingService.markWebhookPaymentFailed({
        orderId: 'order_never_existed', paymentId: 'pay_x',
      });

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('unknown_order');
    });
  });

  describe('mock billing is never reachable in production', () => {
    test('allowed in a non-production env without a live key', () => {
      mutableConfig.env = 'development';
      mutableConfig.razorpay.keyId = 'rzp_test_fixture';
      expect(isMockBillingAllowed()).toBe(true);
    });

    test('refused in production, even with no Razorpay key configured at all', () => {
      mutableConfig.env = 'production';
      mutableConfig.razorpay.keyId = '';
      expect(isMockBillingAllowed()).toBe(false);
      mutableConfig.env = 'development';
    });

    test('refused whenever a live key is configured, regardless of env', () => {
      mutableConfig.env = 'development';
      mutableConfig.razorpay.keyId = 'rzp_live_real';
      expect(isMockBillingAllowed()).toBe(false);
    });
  });

  describe('createQrOrder', () => {
    test('charges the server-authoritative amount, not a client-supplied one', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_qr_created' });
      mockQrCodeCreate.mockResolvedValue({ id: 'qr_1', image_url: 'https://rzp.io/i/fake.png' });

      const result = await razorpayBillingService.createQrOrder(USER_A, PlanCode.PRO);

      expect(mockQrCodeCreate).toHaveBeenCalledWith(
        expect.objectContaining({ fixed_amount: true, payment_amount: 99900, usage: 'single_use' }),
      );
      expect(result.priceInr).toBe(999);
      expect(mockPrisma.billingHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ externalId: 'qr_1', amountCents: 99900, status: 'PENDING' }),
        }),
      );
    });

    test('FREE plan cannot be purchased via QR either', async () => {
      await expect(razorpayBillingService.createQrOrder(USER_A, PlanCode.FREE)).rejects.toThrow();
      expect(mockQrCodeCreate).not.toHaveBeenCalled();
    });

    test('a Razorpay-side rejection (e.g. UPI not enabled for the merchant) surfaces as 502, not a silent failure', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockQrCodeCreate.mockRejectedValue({
        statusCode: 400,
        error: { code: 'BAD_REQUEST_ERROR', description: 'UPI transactions are not enabled for the merchant' },
      });

      await expect(razorpayBillingService.createQrOrder(USER_A, PlanCode.PRO)).rejects.toThrow(/could not create the QR code/i);
      expect(mockPrisma.billingHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('webhook reconciliation (qr_code.credited) — same activation path as payment.captured, keyed by the QR code id', () => {
    test('activates a PENDING QR order on first delivery', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_qr1', status: 'PENDING', amountCents: 1000, currency: 'INR',
        subscriptionId: SUB_A.id,
        rawPayload: { planCode: 'PRO', userId: USER_A, qrCodeId: 'qr_w1' },
        subscription: SUB_A,
      });

      const result = await razorpayBillingService.activateFromWebhookCapture({
        orderId: 'qr_w1', paymentId: 'pay_qr_w1', amountCaptured: 1000, currency: 'INR',
      });

      expect(result.handled).toBe(true);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('getBillingStatus — ownership scoping (IDOR check)', () => {
    test('a billing row belonging to a different user\'s subscription is not returned', async () => {
      // USER_B polls a billingId that in fact belongs to USER_A's subscription.
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_B);
      mockPrisma.billingHistory.findFirst.mockResolvedValue(null); // scoped query (subscriptionId: SUB_B.id) finds nothing

      await expect(razorpayBillingService.getBillingStatus(USER_B, 'bh_belongs_to_A')).rejects.toThrow(/not found/i);

      expect(mockPrisma.billingHistory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'bh_belongs_to_A', subscriptionId: SUB_B.id } }),
      );
    });

    test('returns status and paymentId for the owning user\'s own row', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        status: 'SUCCEEDED',
        rawPayload: { paymentId: 'pay_abc123' },
      });

      const result = await razorpayBillingService.getBillingStatus(USER_A, 'bh_own');
      expect(result).toEqual({ status: 'SUCCEEDED', paymentId: 'pay_abc123' });
    });
  });

  describe('webhook signature — missing secret fails safe', () => {
    test('a configured RAZORPAY_WEBHOOK_SECRET that is empty rejects every delivery, even with a signature header present', () => {
      mutableConfig.razorpay.webhookSecret = '';
      const raw = Buffer.from('{"event":"payment.captured"}');
      // Even a signature computed with the right algorithm over the right body
      // is rejected once the secret itself is unset — there is nothing valid
      // to compare it against.
      const sig = crypto.createHmac('sha256', 'whatever-the-attacker-guesses').update(raw).digest('hex');
      expect(verifyRazorpayWebhookSignature(raw, sig)).toBe(false);
    });

    test('a missing signature header is rejected even with a correctly configured secret', () => {
      mutableConfig.razorpay.webhookSecret = 'webhook_secret_fixture';
      const raw = Buffer.from('{"event":"payment.captured"}');
      expect(verifyRazorpayWebhookSignature(raw, undefined)).toBe(false);
    });
  });

  describe('public config never leaks the secret', () => {
    test('getPublicConfig exposes only the key id, never the key secret or webhook secret', () => {
      mutableConfig.razorpay.keySecret = 'super-secret-value-must-not-leak';
      mutableConfig.razorpay.webhookSecret = 'another-secret-must-not-leak';
      const publicConfig = razorpayBillingService.getPublicConfig();
      const serialized = JSON.stringify(publicConfig);
      expect(serialized).not.toContain('super-secret-value-must-not-leak');
      expect(serialized).not.toContain('another-secret-must-not-leak');
      expect(publicConfig).not.toHaveProperty('keySecret');
      expect(publicConfig).not.toHaveProperty('webhookSecret');
    });
  });

  describe('verifyAndActivate — currency mismatch (browser path)', () => {
    test('rejects when the captured currency does not match the order currency', async () => {
      const orderId = 'order_cur1';
      const paymentId = 'pay_cur1';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_cur1', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'captured', amount: 99900, currency: 'USD' });

      await expect(
        razorpayBillingService.verifyAndActivate({
          userId: USER_A, planCode: PlanCode.PRO,
          razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
        }),
      ).rejects.toThrow(/currency/i);
    });

    test('a merely pending (not authorized, not captured) payment grants nothing', async () => {
      const orderId = 'order_pend1';
      const paymentId = 'pay_pend1';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_pend1', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'pending', amount: 99900, currency: 'INR' });

      await expect(
        razorpayBillingService.verifyAndActivate({
          userId: USER_A, planCode: PlanCode.PRO,
          razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
        }),
      ).rejects.toThrow(/not captured/i);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('a database failure during activation never produces a false successful response', () => {
    test('verifyAndActivate propagates a transaction failure rather than returning success', async () => {
      const orderId = 'order_dbfail1';
      const paymentId = 'pay_dbfail1';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_dbfail1', status: 'PENDING', amountCents: 99900, currency: 'INR', rawPayload: {},
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'captured', amount: 99900, currency: 'INR' });
      mockPrisma.$transaction.mockRejectedValueOnce(new Error('connection to database lost'));

      await expect(
        razorpayBillingService.verifyAndActivate({
          userId: USER_A, planCode: PlanCode.PRO,
          razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
        }),
      ).rejects.toThrow(/connection to database lost/);
    });
  });

  describe('verifyAndActivate — storage top-up (no planCode sent by the client)', () => {
    test('activates a storage top-up order without any planCode, creating a StorageGrant only', async () => {
      const orderId = 'order_topup_v1';
      const paymentId = 'pay_topup_v1';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_topup_v1', status: 'PENDING', amountCents: 8000, currency: 'INR',
        rawPayload: { purchaseType: 'storage_topup', packCode: StoragePackCode.GB_2, bytesGranted: 2 * GB },
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'captured', amount: 8000, currency: 'INR' });

      const result = await razorpayBillingService.verifyAndActivate({
        userId: USER_A,
        razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
      });

      expect(result).toMatchObject({ alreadyProcessed: false, bytesGranted: 2 * GB });
      expect(mockPrisma.storageGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: USER_A, type: 'PURCHASED', bytesGranted: BigInt(2 * GB), billingHistoryId: 'bh_topup_v1' }),
        }),
      );
      // A storage top-up never touches the Subscription row or FeatureEntitlement.
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
      expect(mockPrisma.featureEntitlement.upsert).not.toHaveBeenCalled();
    });

    test('a replayed already-SUCCEEDED storage top-up is idempotent and never calls assignPlan', async () => {
      const orderId = 'order_topup_v2';
      const paymentId = 'pay_topup_v2';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_topup_v2', status: 'SUCCEEDED', amountCents: 8000, currency: 'INR',
        rawPayload: { purchaseType: 'storage_topup', packCode: StoragePackCode.GB_2, bytesGranted: 2 * GB },
      });

      const result = await razorpayBillingService.verifyAndActivate({
        userId: USER_A,
        razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
      });

      expect(result).toEqual({ alreadyProcessed: true });
      expect(subscriptionService.assignPlan).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    test('a storage top-up billing row with no recoverable bytesGranted is refused rather than silently granting nothing', async () => {
      const orderId = 'order_topup_v3';
      const paymentId = 'pay_topup_v3';
      const signature = sign(orderId, paymentId);

      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_topup_v3', status: 'PENDING', amountCents: 8000, currency: 'INR',
        rawPayload: { purchaseType: 'storage_topup', packCode: StoragePackCode.GB_2 }, // bytesGranted missing
      });
      mockPaymentsFetch.mockResolvedValue({ order_id: orderId, status: 'captured', amount: 8000, currency: 'INR' });

      await expect(
        razorpayBillingService.verifyAndActivate({
          userId: USER_A,
          razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature,
        }),
      ).rejects.toThrow(/storage grant details/i);
      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
    });
  });

  describe('activateFromWebhookCapture — storage top-up', () => {
    test('reconciles a storage top-up via webhook, creating a StorageGrant without touching Subscription/FeatureEntitlement', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_topup_w1', status: 'PENDING', amountCents: 8000, currency: 'INR',
        subscriptionId: SUB_A.id,
        rawPayload: { purchaseType: 'storage_topup', packCode: StoragePackCode.GB_2, bytesGranted: 2 * GB, userId: USER_A },
        subscription: SUB_A,
      });

      const result = await razorpayBillingService.activateFromWebhookCapture({
        orderId: 'order_topup_w1', paymentId: 'pay_topup_w1', amountCaptured: 8000, currency: 'INR',
      });

      expect(result.handled).toBe(true);
      expect(mockPrisma.storageGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: USER_A, bytesGranted: BigInt(2 * GB), billingHistoryId: 'bh_topup_w1' }),
        }),
      );
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
      expect(mockPrisma.featureEntitlement.upsert).not.toHaveBeenCalled();
    });

    test('a storage top-up billing row missing bytesGranted is logged and ignored, not acted on', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_topup_w2', status: 'PENDING', amountCents: 8000, currency: 'INR',
        subscriptionId: SUB_A.id,
        rawPayload: { purchaseType: 'storage_topup', packCode: StoragePackCode.GB_2 },
        subscription: SUB_A,
      });

      const result = await razorpayBillingService.activateFromWebhookCapture({
        orderId: 'order_topup_w2', paymentId: 'pay_topup_w2', amountCaptured: 8000, currency: 'INR',
      });

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('missing_bytes_granted');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
