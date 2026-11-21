import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { settingsSchema, toFormValues, toPatch } from '../settings/schema';
import { jsonResponse, renderApp, settingsFixture, signedIn } from '../test/utils';

const base = () => toFormValues(settingsFixture() as never);

function issues(patch: (v: ReturnType<typeof base>) => void) {
  const v = base();
  patch(v);
  const r = settingsSchema.safeParse(v);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]));
}

describe('settings validation (mirrors the PATCH FormRequest)', () => {
  it('accepts the server defaults', () => {
    expect(issues(() => undefined)).toEqual({});
  });

  it('rejects bad contact, social, address and colour values', () => {
    const errs = issues((v) => {
      v.contact.phone = '12345';
      v.contact.email = 'not-email';
      v.social.facebook = 'http://facebook.com/x';
      v.social.instagram = 'https://evil.com/x';
      v.address.postcode = '123';
      v.branding.primary_color = 'blue';
      v.identity.name = 'A';
    });
    expect(Object.keys(errs).sort()).toEqual(
      ['address.postcode', 'branding.primary_color', 'contact.email', 'contact.phone', 'identity.name', 'social.facebook', 'social.instagram'].sort(),
    );
  });

  it('accepts BD and E.164 phones and allowed social hosts', () => {
    expect(
      issues((v) => {
        v.contact.phone = '01712-345678';
        v.contact.whatsapp = '+447700900123';
        v.social.youtube = 'https://youtu.be/abc';
        v.address.postcode = '1216';
        v.address.division = 'Dhaka';
      }),
    ).toEqual({});
  });

  it('builds a partial patch from dirty keys, turning empty strings into null', () => {
    const v = base();
    v.contact.phone = '';
    v.contact.email = 'hi@shop.com';
    expect(toPatch(v, { contact: { phone: true, email: true } })).toEqual({ contact: { phone: null, email: 'hi@shop.com' } });
  });
});

describe('Store details page', () => {
  it('is read-only for staff', async () => {
    signedIn('staff');
    renderApp(<AppRoutes />, { route: '/settings/store' });
    expect(await screen.findByText(/Only the owner and managers can change store settings/)).toBeInTheDocument();
    expect(screen.getByLabelText('Shop name (English)')).toBeDisabled();
  });

  it('shows field errors and does not PATCH invalid input', async () => {
    const api = signedIn('owner');
    renderApp(<AppRoutes />, { route: '/settings/store' });
    await userEvent.type(await screen.findByLabelText('Facebook page'), 'facebook.com/mypage');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter a full link like https://facebook.com/yourpage')).toBeInTheDocument();
    expect(api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('uploads a logo with progress, then saves only the branding change', async () => {
    class FakeXhr {
      static last: FakeXhr;
      status = 0;
      statusText = '';
      responseText = '';
      body: FormData | null = null;
      upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      constructor() {
        FakeXhr.last = this;
      }
      open() {}
      setRequestHeader() {}
      send(body: FormData) {
        this.body = body;
      }
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    let patch: unknown;
    signedIn('owner', {
      'PATCH /stores/S1/settings': (init) => {
        patch = JSON.parse(String(init.body));
        return jsonResponse(200, { data: settingsFixture({ updated_at: '2026-11-22T00:00:00Z' }) });
      },
    });
    renderApp(<AppRoutes />, { route: '/settings/store' });
    const input = await screen.findByLabelText('Upload shop logo');

    // Client-side guard: SVG is rejected without uploading.
    fireEvent.change(input, { target: { files: [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })] } });
    expect(await screen.findByText(/SVG and GIF aren’t supported/)).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], 'logo.png', { type: 'image/png' })] } });
    await waitFor(() => expect(FakeXhr.last?.body?.get('purpose')).toBe('logo'));
    FakeXhr.last.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 2 });
    expect(await screen.findByRole('button', { name: 'Uploading 50%' })).toBeDisabled();
    FakeXhr.last.status = 201;
    FakeXhr.last.responseText = JSON.stringify({
      data: { id: '01MEDIA', purpose: 'logo', status: 'ready', mime: 'image/png', size_bytes: 10, width: 200, height: 200, alt: null, url: 'http://cdn/o.png', variants: [{ key: 'w320', width: 200, height: 200, mime: 'image/webp', url: 'http://cdn/w320.webp' }], created_at: '' },
    });
    FakeXhr.last.onload!();

    expect(await screen.findByAltText('Shop logo preview')).toHaveAttribute('src', 'http://cdn/w320.webp');
    expect(screen.getByText('Branding edited')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patch).toEqual({ branding: { logo_media_id: '01MEDIA' } }));
    expect(await screen.findByText(/Changes saved/)).toBeInTheDocument();
  });

  it('shows server upload validation errors', async () => {
    class FakeXhr {
      static last: FakeXhr;
      status = 0;
      statusText = '';
      responseText = '';
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror = null;
      onabort = null;
      constructor() {
        FakeXhr.last = this;
      }
      open() {}
      setRequestHeader() {}
      send() {
        this.status = 422;
        this.responseText = JSON.stringify({ error: { code: 'validation_failed', message: 'Invalid', details: { file: ['The favicon must be square.'] } } });
        queueMicrotask(() => this.onload!());
      }
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    signedIn('owner');
    renderApp(<AppRoutes />, { route: '/settings/store' });
    fireEvent.change(await screen.findByLabelText('Upload favicon'), { target: { files: [new File([new Uint8Array(4)], 'f.png', { type: 'image/png' })] } });
    expect(await screen.findByText('The favicon must be square.')).toBeInTheDocument();
  });
});

describe('Plan', () => {
  it('shows the trial countdown from /features', async () => {
    const ends = new Date(Date.now() + 5 * 86_400_000 - 1000).toISOString();
    signedIn('owner', {
      'GET /features': jsonResponse(200, {
        data: {
          plan_code: 'starter',
          subscription_status: 'trialing',
          trial_ends_at: ends,
          features: {},
          limits: { orders_per_month: { limit: 500, used: 0 }, staff_seats: { limit: 5, used: 1 }, products: { limit: 1000, used: 0 }, courier_connections: { limit: null, used: 0 } },
        },
      }),
    });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('Starter trial · 5 days left')).toBeInTheDocument(); // sidebar plan card
    const banner = screen.getAllByRole('status').find((el) => el.textContent?.includes('Starter trial —'));
    expect(banner).toHaveTextContent('5 days left');
  });
});
