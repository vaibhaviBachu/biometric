/**
 * Storage top-up purchases via Stripe — checkout session creation and
 * webhook activation. Shares the stripe.service.ts webhook entry point
 * with subscription purchases (see stripe-billing.test.ts); these tests
 * cover the storage-topup-specific branch and activateStorageTopUp.
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
  subscriptionService: { ensureDefaultSubscription: jest.fn(async () => undefined) },
}));

import { config } from '../../src/config';
import { stripeBillingService } from '../../src/services/subscription/billing/stripe.service';
import { StoragePackCode } from '../../src/services/subscription/constants/storage-packs';

const mutableConfig = config as unknown as {
  hub: { appUrl: string };
  stripe: {
    secretKey: string; webhookSecret: string; testPriceOverrideEnabled: boolean; testProPriceCents: number;
    testProStorageGb: number; testCurrency: string; testStoragePriceCentsPerGb: number; testStoragePricePaisePerGb: number;
  };
};

const USER_A = 'user-a-uuid';
const SUB_A = { id: 'sub-a-id', userId: USER_A };
const GB = 1024 * 1024 * 1024;

function paidTopUpSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_topup_1',
    payment_status: 'paid',
    amount_total: 100,
    currency: 'usd',
    payment_intent: 'pi_topup_1',
    ...overrides,
  } as never;
}

describe('storage top-up via Stripe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutableConfig.stripe.secretKey = 'sk_test_fixture';
    mutableConfig.stripe.webhookSecret = 'whsec_fixture';
    mutableConfig.stripe.testCurrency = 'usd';
    mutableConfig.stripe.testStoragePriceCentsPerGb = 50;
    mutableConfig.stripe.testStoragePricePaisePerGb = 0; // INR off by default — each test opts in explicitly
    mutableConfig.stripe.testPriceOverrideEnabled = true;
    mutableConfig.hub.appUrl = 'https://hub.example.com';
    mockPrisma.storageGrant.create.mockResolvedValue({ id: 'grant-id' });
  });

  describe('createStorageTopUpCheckoutSession', () => {
    test('charges a per-GB server-authoritative price — a 2 GB pack costs 2x the 1 GB rate', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_topup_1' });
      mockSessionsCreate.mockResolvedValue({ id: 'cs_topup_1', url: 'https://checkout.stripe.com/cs_topup_1' });

      const result = await stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_2);

      expect(result.amountCents).toBe(100); // 2 GB * 50c/GB
      expect(result.bytesGranted).toBe(2 * GB);
      expect(mockPrisma.billingHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amountCents: 100, provider: 'STRIPE', externalId: 'cs_topup_1' }),
        }),
      );
      const createCall = mockPrisma.billingHistory.create.mock.calls[0][0] as { data: { rawPayload: Record<string, unknown> } };
      expect(createCall.data.rawPayload).toMatchObject({ purchaseType: 'storage_topup', packCode: 'GB_2', bytesGranted: 2 * GB });
    });

    test('works on the FREE plan — a top-up is not gated behind being a paying subscriber', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ id: 'sub-free', userId: USER_A });
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_topup_free' });
      mockSessionsCreate.mockResolvedValue({ id: 'cs_topup_free', url: 'https://checkout.stripe.com/cs_topup_free' });

      await expect(stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_1)).resolves.toMatchObject({
        bytesGranted: 1 * GB,
      });
    });

    test('refuses an unknown pack code', async () => {
      await expect(stripeBillingService.createStorageTopUpCheckoutSession(USER_A, 'GB_999' as StoragePackCode)).rejects.toThrow();
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });

    test('refuses when no storage price is configured at all', async () => {
      mutableConfig.stripe.testPriceOverrideEnabled = false;
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_1)).rejects.toThrow(/no storage top-up price/i);
    });

    test('refuses the override against a live key', async () => {
      mutableConfig.stripe.secretKey = 'sk_live_real';
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_1)).rejects.toThrow();
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });
  });

  describe('multi-currency — INR for India, USD for international', () => {
    test('defaults to USD when no currency is requested — exact pre-existing behavior, unchanged', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_default' });
      mockSessionsCreate.mockResolvedValue({ id: 'cs_default', url: 'https://checkout.stripe.com/cs_default' });

      const result = await stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_1);

      expect(result.currency).toBe('usd');
      expect(result.amountCents).toBe(50); // unchanged USD rate
    });

    test('charges the correct INR amount from its own independent per-GB rate, once configured', async () => {
      mutableConfig.stripe.testStoragePricePaisePerGb = 4000; // ₹40/GB dev placeholder
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_inr' });
      mockSessionsCreate.mockResolvedValue({ id: 'cs_inr', url: 'https://checkout.stripe.com/cs_inr' });

      const result = await stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_2, 'inr');

      expect(result.currency).toBe('inr');
      expect(result.amountCents).toBe(8000); // 2 GB * ₹40 (4000 paise)
      expect(mockSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [expect.objectContaining({ price_data: expect.objectContaining({ currency: 'inr', unit_amount: 8000 }) })],
        }),
      );
    });

    test('is case-insensitive and accepts "INR" the same as "inr"', async () => {
      mutableConfig.stripe.testStoragePricePaisePerGb = 4000;
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_inr_caps' });
      mockSessionsCreate.mockResolvedValue({ id: 'cs_inr_caps', url: 'https://checkout.stripe.com/cs_inr_caps' });

      const result = await stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_1, 'INR');
      expect(result.currency).toBe('inr');
    });

    test('refuses INR specifically when only USD has a configured rate — USD being ready does not imply INR is', async () => {
      // testStoragePricePaisePerGb stays 0 from beforeEach — USD alone is configured.
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_1, 'inr'))
        .rejects.toThrow(/no storage top-up price is configured yet for inr/i);
      expect(mockSessionsCreate).not.toHaveBeenCalled();
      // And USD independently still works in the same environment:
      mockPrisma.billingHistory.create.mockResolvedValue({ id: 'bh_usd_still_fine' });
      mockSessionsCreate.mockResolvedValue({ id: 'cs_usd_still_fine', url: 'https://x' });
      await expect(stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_1, 'usd')).resolves.toMatchObject({ currency: 'usd' });
    });

    test('rejects an unsupported currency outright — never falls back to a different one silently', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(stripeBillingService.createStorageTopUpCheckoutSession(USER_A, StoragePackCode.GB_1, 'gbp'))
        .rejects.toThrow(/unsupported currency/i);
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });

    test('a client-submitted price/amount is never trusted — the service has no amountCents parameter at all, and a smuggled one is ignored and rejected', async () => {
      // The method signature is (userId, packCode, currency) — nothing
      // resembling a price. Forcing a malformed object through (as any,
      // bypassing TypeScript) to prove defense-in-depth: the lookup keys
      // strictly off packCode and finds no match, so it fails closed rather
      // than ever reading an "amountCents" field out of client input.
      mockPrisma.subscription.findUnique.mockResolvedValue(SUB_A);

      await expect(
        stripeBillingService.createStorageTopUpCheckoutSession(
          USER_A,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { code: StoragePackCode.GB_1, amountCents: 1 } as any,
        ),
      ).rejects.toThrow(/unknown storage pack/i);
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });
  });

  describe('webhook activation — currency enforcement at fulfilment time', () => {
    test('an INR session is only fulfilled when the billing row itself expected INR (currency mismatch still enforced)', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_inr_mismatch', status: 'PENDING', amountCents: 4000, currency: 'INR',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup', bytesGranted: 1 * GB }, subscription: SUB_A,
      });

      // Stripe reports the session as USD — does not match the INR row.
      const result = await stripeBillingService.activateFromWebhookSession(
        paidTopUpSession({ id: 'cs_inr_mismatch', amount_total: 4000, currency: 'usd' }),
      );

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('currency_mismatch');
      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
    });

    test('a correctly-matched INR session activates normally', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_inr_ok', status: 'PENDING', amountCents: 4000, currency: 'INR',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup', bytesGranted: 1 * GB }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(
        paidTopUpSession({ id: 'cs_inr_ok', amount_total: 4000, currency: 'inr' }),
      );

      expect(result.handled).toBe(true);
      expect(mockPrisma.storageGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ bytesGranted: BigInt(1 * GB), billingHistoryId: 'bh_inr_ok' }) }),
      );
    });
  });

  describe('webhook activation (checkout.session.completed, purchaseType=storage_topup)', () => {
    test('grants a permanent StorageGrant and never touches the Subscription row', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_2', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup', packCode: 'GB_2', bytesGranted: 2 * GB, userId: USER_A }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidTopUpSession());

      expect(result.handled).toBe(true);
      expect(mockPrisma.storageGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: USER_A, type: 'PURCHASED', bytesGranted: BigInt(2 * GB), billingHistoryId: 'bh_2' }) }),
      );
      // The defining property of a top-up: no plan/period change.
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
      expect(mockPrisma.featureEntitlement.upsert).not.toHaveBeenCalled();
    });

    test('a second top-up for a different session creates a second, independent grant', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_3', status: 'PENDING', amountCents: 250, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup', packCode: 'GB_5', bytesGranted: 5 * GB, userId: USER_A }, subscription: SUB_A,
      });

      await stripeBillingService.activateFromWebhookSession(paidTopUpSession({ id: 'cs_topup_2', amount_total: 250 }));

      expect(mockPrisma.storageGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ bytesGranted: BigInt(5 * GB), billingHistoryId: 'bh_3' }) }),
      );
    });

    test('a concurrent/duplicate grant attempt for the same billing row is swallowed, not a crash', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_race', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup', packCode: 'GB_1', bytesGranted: 1 * GB, userId: USER_A }, subscription: SUB_A,
      });
      const uniqueViolation = Object.assign(new Error('Unique constraint failed on billingHistoryId'), { code: 'P2002' });
      mockPrisma.storageGrant.create.mockRejectedValueOnce(uniqueViolation);

      await expect(stripeBillingService.activateFromWebhookSession(paidTopUpSession({ id: 'cs_topup_race' })))
        .resolves.toMatchObject({ handled: true });
    });

    test('duplicate webhook delivery for an already-SUCCEEDED top-up is a no-op (not a double grant)', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_4', status: 'SUCCEEDED', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup', bytesGranted: 1 * GB }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidTopUpSession({ id: 'cs_topup_dup' }));

      expect(result.handled).toBe(true);
      expect(result.reason).toBe('already_processed');
      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
    });

    test('an unpaid top-up session grants nothing', async () => {
      const result = await stripeBillingService.activateFromWebhookSession(paidTopUpSession({ payment_status: 'unpaid' }));
      expect(result.handled).toBe(false);
      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
    });

    test('a top-up session for an unrecognized id grants nothing (no user to misattribute to)', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue(null);
      const result = await stripeBillingService.activateFromWebhookSession(paidTopUpSession({ id: 'cs_never_created' }));
      expect(result.handled).toBe(false);
      expect(result.reason).toBe('unknown_session');
      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
    });

    test('amount mismatch on a top-up session is refused', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_5', status: 'PENDING', amountCents: 500, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup', bytesGranted: 10 * GB }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidTopUpSession({ id: 'cs_topup_5', amount_total: 1 }));

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('amount_mismatch');
      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
    });

    test('currency mismatch on a top-up session is refused', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_6', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup', bytesGranted: 1 * GB }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidTopUpSession({ id: 'cs_topup_6', currency: 'eur' }));

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('currency_mismatch');
    });

    test('a billing row with no recoverable bytesGranted is refused rather than granting an arbitrary amount', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_7', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup' /* no bytesGranted */ }, subscription: SUB_A,
      });

      const result = await stripeBillingService.activateFromWebhookSession(paidTopUpSession({ id: 'cs_topup_7' }));

      expect(result.handled).toBe(false);
      expect(result.reason).toBe('missing_bytes_granted');
      expect(mockPrisma.storageGrant.create).not.toHaveBeenCalled();
    });

    test('a database failure during activation propagates rather than returning a false success', async () => {
      mockPrisma.billingHistory.findFirst.mockResolvedValue({
        id: 'bh_dbfail', status: 'PENDING', amountCents: 100, currency: 'USD',
        subscriptionId: SUB_A.id, rawPayload: { purchaseType: 'storage_topup', bytesGranted: 1 * GB }, subscription: SUB_A,
      });
      mockPrisma.$transaction.mockRejectedValueOnce(new Error('connection to database lost'));

      await expect(stripeBillingService.activateFromWebhookSession(paidTopUpSession({ id: 'cs_topup_dbfail' })))
        .rejects.toThrow(/connection to database lost/);
    });
  });
});
