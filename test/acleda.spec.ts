import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACLEDA_NOT_REFUNDABLE,
  AcledaClient,
  AcledaConfigError,
  AcledaInputError,
  AcledaRefusedError,
  AcledaUnreachableError,
  acledaCallbackToken,
  acledaCallbackUrl,
  acledaHash,
  acledaUrl,
  acledaCallbackTokenHash,
  verifyAcledaCallback,
  type AcledaConfig,
} from '../src/index';

const ACCOUNT = { loginId: 'lotus-login', password: 'pw-secret', merchantId: 'MID-7', merchantName: 'LOTUSLIME', secretKey: 'sk-secret' };
const NOW = new Date('2026-11-15T03:04:05Z');

/**
 * A fake ACLEDA answering the documented shapes, remembering every request so a test can prove what
 * was sent (the hash, the amount). Beyond the documented fields, ACLEDA's answers are unconfirmed.
 */
function fakeAcleda() {
  const state = { status: {} as Record<string, unknown>, refund: { code: 0 } as Record<string, unknown>, open: null as Record<string, unknown> | null, down: false, httpStatus: 200 };
  const calls: { op: string; url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const op = url.split('/').pop() ?? '';
    calls.push({ op, url, body });
    if (state.down) throw new Error('connection reset');
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: state.httpStatus });
    if (op === 'openSessionV2') return json(state.open ?? { code: 0, sessionid: 'SESS1', qrValue: '00020101KHQR-TEST-1', xTran: { paymentTokenid: 'TOK1' } });
    if (op === 'getTxnStatus') return json(state.status);
    if (op === 'refundTxn') return json(state.refund);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, state };
}

const client = (fetch: typeof globalThis.fetch, extra: Partial<AcledaConfig> = {}) => new AcledaClient({ ...ACCOUNT, sandbox: true, fetch, now: () => NOW, ...extra });
const paid = (amount: string, currency: string) => ({ code: 0, coreRefNum: 'CORE123', xTran: { purchaseAmount: amount, purchaseCurrency: currency, confirmDate: '2026-11-14' } });
const openParams = { txid: 'TXN1', amount: 450, currency: 'USD', description: 'Order 7', lifetimeMin: 5, callbackUrl: 'https://api.test/cb?token=t' };

describe('hash and URLs: pure', () => {
  it('is HMAC-SHA512 over merchantID+loginId+password+txid, with the secret key, upper-case hex', () => {
    const expected = createHmac('sha512', ACCOUNT.secretKey).update(`${ACCOUNT.merchantId}${ACCOUNT.loginId}${ACCOUNT.password}TXN1`, 'utf8').digest('hex').toUpperCase();
    expect(acledaHash(ACCOUNT, 'TXN1')).toBe(expected);
    expect(acledaHash(ACCOUNT, 'TXN1')).toMatch(/^[0-9A-F]{128}$/);
  });

  it('changes with the secret key and with the value it signs', () => {
    expect(acledaHash(ACCOUNT, 'TXN1')).not.toBe(acledaHash(ACCOUNT, 'TXN2'));
    expect(acledaHash({ ...ACCOUNT, secretKey: 'other' }, 'TXN1')).not.toBe(acledaHash(ACCOUNT, 'TXN1'));
  });

  it('builds the documented path with the merchant name', () => {
    expect(acledaUrl('https://epaymentuat.acledabank.com.kh/', 'LOTUSLIME', 'openSessionV2')).toBe(
      'https://epaymentuat.acledabank.com.kh/LOTUSLIME/XPAYConnectorServiceInterfaceImplV2/XPAYConnectorServiceInterfaceImplV2RS/openSessionV2',
    );
  });

  it('keeps only the SHA-256 of a callback token, and puts the token in the address', () => {
    const token = acledaCallbackToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(acledaCallbackTokenHash('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(acledaCallbackTokenHash('abc')).not.toContain('abc');
    expect(verifyAcledaCallback(token, acledaCallbackTokenHash(token))).toBe(true);
    expect(verifyAcledaCallback(token, acledaCallbackTokenHash(token).toUpperCase())).toBe(true);
    expect(verifyAcledaCallback('other', acledaCallbackTokenHash(token))).toBe(false);
    expect(verifyAcledaCallback('', acledaCallbackTokenHash(''))).toBe(false);
    expect(verifyAcledaCallback(null, acledaCallbackTokenHash(token))).toBe(false);
    expect(verifyAcledaCallback(token, 'short')).toBe(false);
    expect(acledaCallbackUrl('https://api.test/cb', 'a b')).toBe('https://api.test/cb?token=a%20b');
    expect(acledaCallbackUrl('https://api.test/cb?x=1', 't')).toBe('https://api.test/cb?x=1&token=t');
  });
});

describe('open', () => {
  it('sends the documented fields, signed by txid, and reads the QR', async () => {
    const { fetch, calls } = fakeAcleda();
    const opened = await client(fetch).open(openParams);
    expect(opened).toEqual({ txid: 'TXN1', sessionId: 'SESS1', paymentTokenId: 'TOK1', qr: '00020101KHQR-TEST-1', expiresAt: new Date(NOW.getTime() + 5 * 60_000) });
    const [call] = calls;
    expect(call!.url).toBe(acledaUrl('https://epaymentuat.acledabank.com.kh', 'LOTUSLIME', 'openSessionV2'));
    expect(call!.body).toMatchObject({ loginId: 'lotus-login', password: 'pw-secret', merchantID: 'MID-7', hash: acledaHash(ACCOUNT, 'TXN1'), callbackUrl: openParams.callbackUrl });
    expect(call!.body.xpayTransaction).toMatchObject({ txid: 'TXN1', purchaseAmount: '4.50', purchaseCurrency: 'USD', purchaseDate: '20261115030405', expiryTime: 5, quantity: 1 });
  });

  it('cuts the lifetime to what ACLEDA allows, and sends operationType and terminalId only when given', async () => {
    const { fetch, calls } = fakeAcleda();
    await client(fetch, { maxExpiryMin: 3, operationType: 'KHQR', terminalId: 'T1' }).open({ ...openParams, lifetimeMin: 60 });
    expect(calls[0]!.body.xpayTransaction).toMatchObject({ expiryTime: 3, operationType: 'KHQR', terminalId: 'T1' });
    await client(fetch).open({ ...openParams, lifetimeMin: 0 });
    expect(calls[1]!.body.xpayTransaction).toMatchObject({ expiryTime: 1 });
    expect(calls[1]!.body.xpayTransaction).not.toHaveProperty('operationType');
  });

  it('draws the image from the string with format image', async () => {
    const { fetch } = fakeAcleda();
    const opened = await client(fetch).open({ ...openParams, format: 'image' });
    expect(opened.image).toMatch(/^data:image\/png;base64,/);
  });

  it('throws typed errors: the money, a refusal, no answer, no production address', async () => {
    const acleda = fakeAcleda();
    await expect(client(acleda.fetch).open({ ...openParams, currency: 'KHR' })).rejects.toBeInstanceOf(AcledaInputError);
    await expect(client(acleda.fetch).open({ ...openParams, currency: 'KHR' })).rejects.toMatchObject({ problem: 'currency', message: 'ACLEDA takes USD only for now, not KHR' });
    await expect(client(acleda.fetch).open({ ...openParams, format: 'gif' as 'image' })).rejects.toMatchObject({ problem: 'format' });
    expect(acleda.calls).toHaveLength(0);
    acleda.state.open = { code: 9, errorDetails: 'Invalid merchant' };
    await expect(client(acleda.fetch).open(openParams)).rejects.toMatchObject({ acledaCode: '9', details: 'Invalid merchant', message: 'Invalid merchant' });
    acleda.state.open = { code: 0, sessionid: 'S' };
    await expect(client(acleda.fetch).open(openParams)).rejects.toBeInstanceOf(AcledaRefusedError);
    acleda.state.down = true;
    await expect(client(acleda.fetch).open(openParams)).rejects.toBeInstanceOf(AcledaUnreachableError);
    await expect(client(acleda.fetch, { sandbox: false }).open(openParams)).rejects.toBeInstanceOf(AcledaConfigError);
  });

  it('takes riel when told to', async () => {
    const { fetch, calls } = fakeAcleda();
    await client(fetch, { currencies: ['USD', 'KHR'] }).open({ ...openParams, currency: 'KHR', amount: 20900 });
    expect(calls[0]!.body.xpayTransaction).toMatchObject({ purchaseAmount: '20900', purchaseCurrency: 'KHR' });
  });
});

describe('status', () => {
  it('is paid only with success, a coreRefNum, and the amount and money asked', async () => {
    const acleda = fakeAcleda();
    const c = client(acleda.fetch);
    acleda.state.status = paid('4.50', 'USD');
    expect(await c.status('TOK1', { amount: 450, currency: 'USD' })).toBe('paid');
    expect(acleda.calls[0]!.body).toMatchObject({ paymentTokenid: 'TOK1', hash: acledaHash(ACCOUNT, 'TOK1') });
    expect(await c.status('TOK1', { amount: 451, currency: 'USD' })).toBe('pending');
    acleda.state.status = paid('4.50', 'KHR');
    expect(await c.status('TOK1', { amount: 450, currency: 'USD' })).toBe('pending');
    acleda.state.status = { code: 0, xTran: { purchaseAmount: '4.50', purchaseCurrency: 'USD' } };
    expect(await c.status('TOK1', { amount: 450, currency: 'USD' })).toBe('pending');
    acleda.state.status = { code: 0, coreRefNum: 'C' };
    expect(await c.status('TOK1', { amount: 450, currency: 'USD' })).toBe('pending');
    acleda.state.status = { ...paid('4.50', 'USD'), code: 5 };
    expect(await c.status('TOK1', { amount: 450, currency: 'USD' })).toBe('pending');
  });

  it('never throws: no answer, an HTTP error, or no production address is pending', async () => {
    const acleda = fakeAcleda();
    acleda.state.down = true;
    expect(await client(acleda.fetch).status('TOK1', { amount: 450, currency: 'USD' })).toBe('pending');
    acleda.state.down = false;
    acleda.state.httpStatus = 500;
    acleda.state.status = paid('4.50', 'USD');
    expect(await client(acleda.fetch).status('TOK1', { amount: 450, currency: 'USD' })).toBe('pending');
    expect(await client(acleda.fetch, { sandbox: false }).status('TOK1', { amount: 450, currency: 'USD' })).toBe('pending');
  });
});

describe('refund', () => {
  const payment = { txid: 'TXN1', paymentTokenId: 'TOK1', sessionId: 'SESS1' };

  it('sends the refund to the refund address (UAT :8443), signed by txid', async () => {
    const { fetch, calls } = fakeAcleda();
    expect(await client(fetch).refund(payment, 450, 'USD', 'Customer cancelled')).toEqual({ kind: 'refunded' });
    expect(calls[0]!.url).toBe(acledaUrl('https://epaymentuat.acledabank.com.kh:8443', 'LOTUSLIME', 'refundTxn'));
    expect(calls[0]!.body).toMatchObject({ hash: acledaHash(ACCOUNT, 'TXN1'), paymentTokenId: 'TOK1', sessionId: 'SESS1', amount: '4.50', currency: 'USD', reason: 'Customer cancelled' });
  });

  it('says not refundable, keeps ACLEDA’s words otherwise, and is pending with no answer', async () => {
    const acleda = fakeAcleda();
    acleda.state.refund = { code: ACLEDA_NOT_REFUNDABLE };
    expect(await client(acleda.fetch).refund(payment, 450, 'USD', 'x')).toMatchObject({ kind: 'refused', code: ACLEDA_NOT_REFUNDABLE });
    acleda.state.refund = { code: 12, errorDetails: 'Too late' };
    expect(await client(acleda.fetch).refund(payment, 450, 'USD', 'x')).toEqual({ kind: 'refused', code: '12', words: 'Too late' });
    acleda.state.down = true;
    expect(await client(acleda.fetch).refund(payment, 450, 'USD', 'x')).toEqual({ kind: 'pending' });
    expect(await client(acleda.fetch, { sandbox: false }).refund(payment, 450, 'USD', 'x')).toEqual({ kind: 'pending' });
  });
});

describe('secrets', () => {
  it('never reach the log', async () => {
    const acleda = fakeAcleda();
    acleda.state.httpStatus = 500;
    const logged: string[] = [];
    await client(acleda.fetch, { log: (_l, m) => logged.push(m) }).status('TOK1', { amount: 450, currency: 'USD' });
    expect(logged).toEqual(['ACLEDA status answered 500']);
    expect(JSON.stringify(logged)).not.toContain('pw-secret');
    expect(JSON.stringify(logged)).not.toContain('sk-secret');
  });
});
