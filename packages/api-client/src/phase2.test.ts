import { describe, expect, it, vi } from 'vitest';
import { ApiError, auditLogQuery, createApiClient } from './index';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response, extra: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => response);
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getToken: () => 'tok', getTenantId: () => 'T1', ...extra });
  const call = (i = 0) => ({ url: String(fetchMock.mock.calls[i]![0]), init: fetchMock.mock.calls[i]![1]!, headers: fetchMock.mock.calls[i]![1]!.headers as Record<string, string> });
  return { client, call };
}

/** Minimal XHR double: records the request and lets the test drive progress/load. */
class FakeXhr {
  static last: FakeXhr;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: FormData | null = null;
  status = 0;
  statusText = '';
  responseText = '';
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const media = { id: 'M1', purpose: 'logo', status: 'processing', mime: 'image/png', size_bytes: 10, width: 200, height: 200, alt: null, url: 'http://cdn/x.png', variants: [], created_at: '' };

describe('Phase 2 endpoints', () => {
  it('account endpoints skip X-Tenant-Id', async () => {
    const { client, call } = setup(json(200, { data: { token: 'new', user: {}, expires_at: 'x' } }));
    await client.auth.changePassword({ current_password: 'a', password: 'b', password_confirmation: 'b' });
    expect(call().url).toBe('http://api.test/api/v1/auth/password');
    expect(call().init.method).toBe('PUT');
    expect(call().headers.Authorization).toBe('Bearer tok');
    expect(call().headers['X-Tenant-Id']).toBeUndefined();
  });

  it('resetPassword surfaces invalid_reset_token', async () => {
    const { client } = setup(json(422, { error: { code: 'invalid_reset_token', message: 'This reset link is invalid or has expired.' } }));
    await expect(client.auth.resetPassword({ email: 'a@b.co', token: 't', password: 'p', password_confirmation: 'p' })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_reset_token',
    });
  });

  it('staff.list returns seats meta', async () => {
    const { client, call } = setup(json(200, { data: [], meta: { seats_used: 2, seats_limit: 5 } }));
    await expect(client.staff.list()).resolves.toEqual({ data: [], meta: { seats_used: 2, seats_limit: 5 } });
    expect(call().headers['X-Tenant-Id']).toBe('T1');
  });

  it('invitations.accept is anonymous with a body and authenticated (no tenant) without', async () => {
    const a = setup(json(201, { data: { token: 'x', user: {}, expires_at: 'x' } }));
    await a.client.invitations.accept('tk/1', { name: 'N', password: 'p', password_confirmation: 'p', phone: '01712345678' });
    expect(a.call().url).toBe('http://api.test/api/v1/invitations/tk%2F1/accept');
    expect(a.call().headers.Authorization).toBeUndefined();

    const b = setup(json(200, { data: { id: 'T2', name: 'Shop', role: 'staff' } }));
    await b.client.invitations.accept('tk');
    expect(b.call().headers.Authorization).toBe('Bearer tok');
    expect(b.call().headers['X-Tenant-Id']).toBeUndefined();
    expect(b.call().init.body).toBeUndefined();
  });

  it('auditLogQuery maps filters to filter[...] params', async () => {
    expect(auditLogQuery({ action: 'staff.*', created_from: '2026-01-01', per_page: 5 })).toMatchObject({
      'filter[action]': 'staff.*',
      'filter[created_at][gte]': '2026-01-01',
      per_page: 5,
    });
    const { client, call } = setup(json(200, { data: [], meta: { total: 0 } }));
    await client.auditLogs.list({ action: 'staff.*' });
    expect(decodeURIComponent(call().url)).toBe('http://api.test/api/v1/audit-logs?filter[action]=staff.*');
  });

  it('media.upload posts multipart via XHR and reports progress', async () => {
    const client = createApiClient({ baseUrl: 'http://api.test', getToken: () => 'tok', getTenantId: () => 'T1', xhr: () => new FakeXhr() as unknown as XMLHttpRequest });
    const progress: number[] = [];
    const promise = client.media.upload({ file: new File(['x'], 'logo.png', { type: 'image/png' }), purpose: 'logo' }, { onProgress: (p) => progress.push(p) });
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('http://api.test/api/v1/media');
    expect(xhr.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Tenant-Id': 'T1' });
    expect(xhr.headers['Content-Type']).toBeUndefined(); // browser sets the multipart boundary
    expect(xhr.body!.get('purpose')).toBe('logo');
    expect((xhr.body!.get('file') as File).name).toBe('logo.png');
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 50, total: 100 });
    xhr.respond(201, { data: media });
    await expect(promise).resolves.toEqual(media);
    expect(progress).toEqual([0.5, 1]);
  });

  it('media.upload maps validation errors', async () => {
    const client = createApiClient({ baseUrl: 'http://api.test', xhr: () => new FakeXhr() as unknown as XMLHttpRequest });
    const promise = client.media.upload({ file: new Blob(['x']), purpose: 'favicon' });
    FakeXhr.last.respond(422, { error: { code: 'validation_failed', message: 'Invalid', details: { file: ['The favicon must be square.'] } } });
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.fieldError('file')).toBe('The favicon must be square.');
  });

  it('media.waitUntilProcessed polls until ready', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => json(200, { data: { ...media, status: ++n >= 2 ? 'ready' : 'processing' } }));
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    const result = await client.media.waitUntilProcessed(media as never, { intervalMs: 1 });
    expect(result.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('phone OTP (Addendum A)', () => {
  it('sendOtp for login is anonymous and returns dev_otp when present', async () => {
    const { client, call } = setup(json(202, { data: { expires_in: 300, resend_in: 60, dev_otp: '123456' } }));
    await expect(client.auth.sendOtp({ phone: '01712345678', purpose: 'login' })).resolves.toMatchObject({ dev_otp: '123456' });
    expect(call().url).toBe('http://api.test/api/v1/auth/otp/send');
    expect(call().headers.Authorization).toBeUndefined();
  });

  it('sendOtp for verify_phone sends the Bearer token', async () => {
    const { client, call } = setup(json(202, { data: { expires_in: 300, resend_in: 60 } }));
    await client.auth.sendOtp({ phone: '01712345678', purpose: 'verify_phone' });
    expect(call().headers.Authorization).toBe('Bearer tok');
    expect(call().headers['X-Tenant-Id']).toBeUndefined();
  });

  it('exposes retry_after on otp_rate_limited', async () => {
    const { client } = setup(json(429, { error: { code: 'otp_rate_limited', message: 'Too many codes.', retry_after: 42 } }));
    await expect(client.auth.sendOtp({ phone: '01712345678', purpose: 'login' })).rejects.toMatchObject({ status: 429, code: 'otp_rate_limited', retryAfter: 42 });
  });

  it('reads retry_after from details too', async () => {
    const { client } = setup(json(429, { error: { code: 'otp_rate_limited', message: 'x', details: { retry_after: ['17'] } } }));
    await expect(client.auth.sendOtp({ phone: '01712345678', purpose: 'reset_password' })).rejects.toMatchObject({ retryAfter: 17 });
  });

  it('loginWithOtp and resetPasswordWithOtp hit the contract paths', async () => {
    const a = setup(json(200, { data: { token: 't', user: {}, expires_at: 'x' } }));
    await a.client.auth.loginWithOtp({ phone: '8801712345678', code: '123456' });
    expect(a.call().url).toBe('http://api.test/api/v1/auth/login/otp');
    const b = setup(json(200, { data: { message: 'ok' } }));
    await b.client.auth.resetPasswordWithOtp({ phone: '8801712345678', code: '123456', password: 'abc12345', password_confirmation: 'abc12345' });
    expect(b.call().url).toBe('http://api.test/api/v1/auth/reset-password/otp');
    const c = setup(json(200, { data: { id: 'U1' } }));
    await c.client.auth.verifyPhone({ code: '123456' });
    expect(c.call().url).toBe('http://api.test/api/v1/auth/phone/verify');
  });
});
