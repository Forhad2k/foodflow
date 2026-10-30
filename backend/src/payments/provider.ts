import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export type ProviderPaymentStatus = 'PAID' | 'FAILED' | 'PENDING';

export interface PaymentProvider {
  readonly name: string;
  /** Starts a payment at the gateway. The returned redirectUrl is where the customer pays. */
  initialize(i: { paymentId: string; orderNumber: string; amountMinor: number; currency: string }): Promise<{ providerRef: string; redirectUrl: string }>;
  redirectUrl(providerRef: string): string;
  /** Authenticates a callback and extracts the event. NEVER trust anything before `signatureOk` is true. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): { signatureOk: boolean; eventId: string; providerRef: string };
  /** Server-to-server lookup: the authoritative status. Callbacks only say "go look"; they are never believed on their own. */
  fetchStatus(providerRef: string): Promise<{ status: ProviderPaymentStatus; amountMinor: number; currency: string }>;
  /** Idempotent on `refundId`: calling twice refunds once. */
  refund(i: { refundId: string; providerRef: string; amountMinor: number }): Promise<{ status: 'SUCCEEDED' | 'FAILED'; providerRefundRef: string }>;
}

/**
 * DEVELOPMENT ADAPTER. A simulated gateway: no real money moves and nothing leaves this process.
 * It exists so the complete online-payment flow (initialize → signed callback → server-side verification → order
 * placed; failures; duplicates; refunds) works and is tested without gateway credentials.
 * For production implement `PaymentProvider` for a real Bangladeshi gateway (e.g. SSLCommerz, bKash, Nagad: they
 * all offer: create session, IPN/webhook with signature or validation API, status query, refund API) and set
 * PAYMENT_PROVIDER accordingly. The adapter is the ONLY code that changes.
 */
export class DevPaymentProvider implements PaymentProvider {
  readonly name = 'dev';
  private readonly sessions = new Map<string, { amountMinor: number; currency: string; status: ProviderPaymentStatus }>();
  private readonly refunds = new Map<string, { status: 'SUCCEEDED' | 'FAILED' }>();

  constructor(private readonly secret: string, private readonly apiUrl: string) {}

  async initialize(i: { paymentId: string; orderNumber: string; amountMinor: number; currency: string }) {
    const providerRef = `ffpay_${randomBytes(18).toString('base64url')}`; // opaque, unguessable
    this.sessions.set(providerRef, { amountMinor: i.amountMinor, currency: i.currency, status: 'PENDING' });
    return { providerRef, redirectUrl: this.redirectUrl(providerRef) };
  }
  redirectUrl(providerRef: string) {
    return `${this.apiUrl}/api/v1/dev/payments/${providerRef}`;
  }
  /** Test/dev hook: "the customer finished paying" (or failed). */
  complete(providerRef: string, outcome: 'PAID' | 'FAILED', amountMinor?: number) {
    const s = this.sessions.get(providerRef);
    if (!s) throw new Error('unknown dev payment session');
    s.status = outcome;
    if (amountMinor !== undefined) s.amountMinor = amountMinor;
  }
  sign(rawBody: string | Buffer): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const given = String(headers['x-ff-signature'] ?? '');
    const expected = this.sign(rawBody);
    const a = Buffer.from(given.padEnd(expected.length, '0').slice(0, expected.length));
    const signatureOk = given.length === expected.length && timingSafeEqual(a, Buffer.from(expected));
    let eventId = '';
    let providerRef = '';
    try {
      const j = JSON.parse(rawBody.toString('utf8'));
      eventId = String(j.eventId ?? '');
      providerRef = String(j.providerRef ?? '');
    } catch { /* unsigned garbage: signatureOk is false anyway */ }
    return { signatureOk: signatureOk && !!eventId && !!providerRef, eventId, providerRef };
  }
  async fetchStatus(providerRef: string) {
    const s = this.sessions.get(providerRef);
    if (!s) return { status: 'FAILED' as const, amountMinor: 0, currency: 'BDT' };
    return { ...s };
  }
  async refund(i: { refundId: string; providerRef: string; amountMinor: number }) {
    const done = this.refunds.get(i.refundId); // idempotency on refundId
    if (done) return { ...done, providerRefundRef: `ffref_${i.refundId}` };
    const ok = this.sessions.get(i.providerRef)?.status === 'PAID';
    const r = { status: ok ? ('SUCCEEDED' as const) : ('FAILED' as const) };
    this.refunds.set(i.refundId, r);
    return { ...r, providerRefundRef: `ffref_${i.refundId}` };
  }
}
