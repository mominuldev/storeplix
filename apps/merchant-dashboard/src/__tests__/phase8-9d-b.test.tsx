import { ApiError } from '@storeplix/api-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { impersonation } from '../impersonation/store';
import {
  aiErrorText,
  appendVariant,
  canUndo,
  creditsLevel,
  generationStatusMeta,
  parseKeyPoints,
  photoEditInput,
  variantToDoc,
} from '../integrations/ai';
import { capabilitiesOf, nagadFieldProblem, nagadInput } from '../payments/nagad';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { product } from './catalog.fixtures';
import { connected, integration, summary } from './phase8-9d.fixtures';
import { credits, drafts, generation, nagad, nagadConnected, noCredits, photoDone, photoEdit } from './phase8-9d-b.fixtures';

// PHASE-8-9D §16 Web (part B): Nagad page (write-only PEM keys + Replace, greyed capabilities, callback URL, enable),
// Integrations list (Nagad card, AI for growth group + chip, Coming soon), AI tool pages (Turn on / Turn off, tabs),
// "Write with AI" in the product editor (queued → drafts → fill editor, never auto-saved), credits exhausted state,
// AI photos (presets, before/after, Save to product, Undo), permissions.

vi.setConfig({ testTimeout: 20_000 });
const SLOW = { timeout: 5000 };

afterEach(() => {
  vi.restoreAllMocks();
  impersonation.set(null);
});

const ok = (data: unknown, meta?: unknown) => jsonResponse(200, meta === undefined ? { data } : { data, meta });
const accepted = (data: unknown) => jsonResponse(202, { data });
const err = (status: number, code: string, details?: Record<string, unknown>) => jsonResponse(status, { error: { code, message: code, details } });
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const cursor = { next_cursor: null, prev_cursor: null, per_page: 50 };

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(12)}\n-----END PRIVATE KEY-----`;
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----\n${'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'.repeat(10)}\n-----END PUBLIC KEY-----`;

const media = (id: string, url: string) => ({ id, url, width: 1200, height: 1200, status: 'ready' as const });
const productWithPhoto = () => product({ images: [{ media_id: 'M1', alt: null, position: 0, media: media('M1', 'https://cdn.test/m1.jpg') }] as never });

describe('PHASE-8-9D part B helpers', () => {
  it('Nagad fields: merchant number is a BD mobile, keys must be the right kind (§9.2)', () => {
    expect(nagadFieldProblem('merchant_number', '01700-000000')).toBeNull();
    expect(nagadFieldProblem('merchant_number', '+8801700000000')).toBeNull();
    expect(nagadFieldProblem('merchant_number', '0170000')).toMatch(/11-digit/);
    expect(nagadFieldProblem('merchant_id', '683002007104225')).toBeNull();
    expect(nagadFieldProblem('merchant_id', 'abc def')).toMatch(/letters and numbers/);
    expect(nagadFieldProblem('merchant_private_key', PRIVATE_KEY)).toBeNull();
    expect(nagadFieldProblem('merchant_private_key', PUBLIC_KEY)).toMatch(/This is a public key/);
    expect(nagadFieldProblem('pg_public_key', PRIVATE_KEY)).toMatch(/This is a private key/);
    expect(nagadFieldProblem('pg_public_key', 'hello')).toMatch(/doesn’t look like a public key/);
    expect(nagadInput({ merchant_id: ' 6830 '.trim(), merchant_number: '+88 01700-000000', merchant_private_key: ` ${PRIVATE_KEY} `, pg_public_key: PUBLIC_KEY })).toMatchObject({ merchant_number: '01700000000', merchant_private_key: PRIVATE_KEY });
    expect(capabilitiesOf(undefined)).toEqual(['query', 'webhook']);
    expect(capabilitiesOf(nagad({ capabilities: ['refund', 'query'] }))).toEqual(['refund', 'query']);
  });

  it('writer helpers: key points, plain-text doc (never HTML), insert below keeps the merchant’s text', () => {
    expect(parseKeyPoints('half-silk, Eid\nhand wash only,, ')).toEqual(['half-silk', 'Eid', 'hand wash only']);
    expect(parseKeyPoints(Array.from({ length: 12 }, (_, i) => `p${i}`).join(','))).toHaveLength(10);
    const v = { paragraphs: ['<b>Hi</b>'], highlights: ['One'] };
    expect(variantToDoc(v)).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '<b>Hi</b>' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }] },
      ],
    });
    const mine = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Mine' }] }] };
    expect(appendVariant(mine, v).content).toHaveLength(3);
    expect(appendVariant(null, v)).toEqual(variantToDoc(v));
  });

  it('statuses, credits level, presets, undo window and error copy', () => {
    expect(generationStatusMeta(photoDone({ status: 'applied' })).label).toBe('Saved');
    expect(generationStatusMeta(photoDone({ check_edges: true })).label).toBe('Check edges');
    expect(generationStatusMeta(photoEdit({ status: 'failed' })).label).toBe('Failed · free');
    expect(generationStatusMeta(photoEdit({ status: 'undone' })).label).toBe('Undone');
    expect(creditsLevel(credits())).toBe('ok');
    expect(creditsLevel(credits({ available: 20 }))).toBe('low');
    expect(creditsLevel(noCredits())).toBe('out');
    expect(photoEditInput('M1', 'P1', 'transparent')).toEqual({ media_id: 'M1', product_id: 'P1', operation: 'remove_background', background: null });
    expect(photoEditInput('M1', null, 'mint')).toMatchObject({ operation: 'replace_background', background: 'mint' });
    expect(canUndo(photoDone({ status: 'applied', original_kept_until: '2099-01-01T00:00:00Z' }))).toBe(true);
    expect(canUndo(photoDone({ status: 'applied', original_kept_until: '2020-01-01T00:00:00Z' }))).toBe(false);
    expect(aiErrorText(new ApiError(402, 'ai_credits_exhausted', 'x', { needed: 2, available: 1, resets_at: '2026-12-01T00:00:00Z' }))).toMatch(/You need 2 credits and have 1 left\. Your credits reset on 1 Dec 2026/);
    expect(aiErrorText(new ApiError(409, 'ai_integration_off', 'x'))).toMatch(/turned off/);
  });
});

const listRoutes = (aiList = [summary('ai_writer', { status: 'connected' }), summary('ai_photos')]) => ({
  'GET /stores/S1/payment-gateways': ok([nagadConnected()]),
  'GET /stores/S1/couriers': ok([]),
  'GET /stores/S1/integrations': ok([summary('meta_pixel'), summary('ga4'), summary('tiktok_pixel'), summary('gtm_server'), summary('meta_catalog'), summary('google_merchant'), ...aiList]),
});

describe('PHASE-8-9D part B Integrations list (P89D-50)', () => {
  it('Payments shows Nagad linking to its page; AI for growth shows Claude (On) and AI photos (Off); AI chip filters', async () => {
    signedIn('owner', listRoutes());
    renderApp(<AppRoutes />, { route: '/integrations' });
    const payments = await screen.findByRole('region', { name: 'Payments' }, SLOW);
    const card = await within(payments).findByRole('article', { name: 'Nagad' });
    expect(within(card).getByText('Connected')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Manage Nagad' })).toHaveAttribute('href', '/integrations/payments/nagad');
    const ai = await screen.findByRole('region', { name: 'AI for growth' });
    expect(within(within(ai).getByRole('article', { name: 'Claude by Anthropic' })).getByText('On')).toBeInTheDocument();
    expect(within(ai).getByRole('link', { name: 'Manage Claude by Anthropic' })).toHaveAttribute('href', '/integrations/claude');
    expect(within(ai).getByRole('link', { name: 'Turn on AI product photos' })).toHaveAttribute('href', '/integrations/ai-photos');
    expect(screen.getByRole('button', { name: 'Connected · 2' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'AI' }));
    expect(screen.queryByRole('region', { name: 'Payments' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'AI for growth' })).toBeInTheDocument();
  });

  it('AI photos is "Coming soon" when the API leaves it out (no image provider, P89D-39)', async () => {
    signedIn('owner', listRoutes([summary('ai_writer')]));
    renderApp(<AppRoutes />, { route: '/integrations?filter=ai' });
    const ai = await screen.findByRole('region', { name: 'AI for growth' }, SLOW);
    const photos = await within(ai).findByRole('article', { name: 'AI product photos' });
    expect(within(photos).getByText('Coming soon')).toBeInTheDocument();
    expect(within(photos).queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('PHASE-8-9D Nagad page (2134:67228)', () => {
  it('not connected: validates PEM keys and the BD number client-side, then PUTs all four credentials once', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/payment-gateways': ok([nagad()]),
      'PUT /stores/S1/payment-gateways/nagad': ok(nagadConnected({ verified_at: null })),
    });
    renderApp(<AppRoutes />, { route: '/integrations/payments/nagad' });
    const form = await screen.findByRole('form', { name: 'Nagad credentials' }, SLOW);
    await userEvent.type(within(form).getByLabelText('Merchant ID'), '683002007104225');
    await userEvent.type(within(form).getByLabelText('Merchant number'), '01700');
    await userEvent.click(within(form).getByLabelText('Merchant private key'));
    await userEvent.paste(PUBLIC_KEY);
    await userEvent.click(within(form).getByRole('button', { name: 'Save and connect' }));
    expect(await within(form).findByText(/11-digit Nagad number/)).toBeInTheDocument();
    expect(within(form).getByText(/This is a public key/)).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/payment-gateways/nagad', 'PUT')).toHaveLength(0);

    await userEvent.clear(within(form).getByLabelText('Merchant number'));
    await userEvent.type(within(form).getByLabelText('Merchant number'), '01700000000');
    await userEvent.clear(within(form).getByLabelText('Merchant private key'));
    await userEvent.click(within(form).getByLabelText('Merchant private key'));
    await userEvent.paste(PRIVATE_KEY);
    await userEvent.click(within(form).getByLabelText('Nagad public key'));
    await userEvent.paste(PUBLIC_KEY);
    await userEvent.click(screen.getByRole('tab', { name: 'Live' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save and connect' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/payment-gateways/nagad', 'PUT')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/payment-gateways/nagad', 'PUT')[0]!)).toEqual({
      mode: 'live',
      credentials: { merchant_id: '683002007104225', merchant_number: '01700000000', merchant_private_key: PRIVATE_KEY, pg_public_key: PUBLIC_KEY },
    });
  });

  it('connected: keys are write-only (masked + Replace, never Show/Copy), callback URL copyable, unsupported options greyed', async () => {
    signedIn('owner', { 'GET /stores/S1/payment-gateways': ok([nagadConnected()]) });
    renderApp(<AppRoutes />, { route: '/integrations/payments/nagad' });
    const creds = await screen.findByRole('region', { name: 'Merchant credentials' }, SLOW);
    expect(within(creds).getByText('••••4225')).toBeInTheDocument();
    expect(within(creds).getByRole('button', { name: 'Replace Merchant private key' })).toBeInTheDocument();
    expect(within(creds).queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
    expect(within(creds).queryByText(/BEGIN/)).not.toBeInTheDocument();
    expect(within(creds).getByDisplayValue('https://api.storeplix.com/api/v1/payments/return/nagad')).toBeInTheDocument();
    expect(within(creds).getByText(/test payment and callback verified/)).toBeInTheDocument();
    const options = screen.getByRole('region', { name: 'Checkout options' });
    for (const name of ['Pre-authorise advance', 'Agreement checkout', 'Remember the shopper’s number']) {
      const sw = within(options).getByRole('switch', { name });
      expect(sw).toBeDisabled();
      expect(sw).toHaveAttribute('aria-checked', 'false');
    }
    expect(within(options).getAllByText('Not offered by Nagad yet')).toHaveLength(3);
    expect(within(options).getByText('Refund in the Nagad portal, then record a manual refund')).toBeInTheDocument();
    expect(within(options).getByRole('switch', { name: 'Pay with Nagad wallet' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(within(creds).getByRole('button', { name: 'Replace Merchant private key' }));
    expect(await screen.findByRole('form', { name: 'Nagad credentials' })).toBeInTheDocument();
    expect(screen.getByText(/enter all four again/)).toBeInTheDocument();
  });

  it('turning checkout off PATCHes enabled with the revision; staff see it read-only', async () => {
    const fetchMock = signedIn('owner', { 'GET /stores/S1/payment-gateways': ok([nagadConnected()]), 'PATCH /stores/S1/payment-gateways/nagad': ok(nagadConnected({ enabled: false, revision: 5 })) });
    renderApp(<AppRoutes />, { route: '/integrations/payments/nagad' });
    await userEvent.click(await screen.findByRole('switch', { name: 'Pay with Nagad wallet' }, SLOW));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/payment-gateways/nagad', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/payment-gateways/nagad', 'PATCH')[0]!)).toEqual({ revision: 4, enabled: false });
  });

  it('staff: no Replace, Test connection or Disconnect', async () => {
    signedIn('staff', { 'GET /stores/S1/payment-gateways': ok([nagadConnected()]) });
    renderApp(<AppRoutes />, { route: '/integrations/payments/nagad' });
    await screen.findByRole('region', { name: 'Merchant credentials' }, SLOW);
    expect(screen.queryByRole('button', { name: /Replace/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Pay with Nagad wallet' })).toBeDisabled();
  });
});

describe('PHASE-8-9D AI tool pages (31:5788, 2135:55033)', () => {
  it('Off by default: Turn on PUTs the default settings; credits card shows the shared pool', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/integrations/ai_writer': ok(integration('ai_writer')),
      'PUT /stores/S1/integrations/ai_writer': ok(connected('ai_writer', {})),
      'GET /billing/ai-credits': ok(credits({ bonus: 50, available: 338 })),
    });
    renderApp(<AppRoutes />, { route: '/integrations/claude' });
    expect(await screen.findByRole('heading', { name: 'Claude by Anthropic' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(await screen.findByTestId('ai-credits-available')).toHaveTextContent('338');
    expect(screen.getByText(/Shared by Claude and AI product photos/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Turn on' })[0]!);
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/ai_writer', 'PUT')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/ai_writer', 'PUT')[0]!)).toEqual({ settings: { default_language: 'bn', default_tone: 'friendly', default_length: 'medium', use_product_image: true } });
    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeInTheDocument();
  });

  it('On: Turn off asks first, then POSTs disconnect; settings PATCH with the revision', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/integrations/ai_photos': ok(connected('ai_photos', {})),
      'POST /stores/S1/integrations/ai_photos/disconnect': ok(integration('ai_photos', { status: 'disconnected' })),
      'PATCH /stores/S1/integrations/ai_photos': ok(connected('ai_photos', { default_background: 'mint' })),
      'GET /billing/ai-credits': ok(credits()),
      'GET /stores/S1/products': ok([], { current_page: 1, per_page: 50, total: 0, last_page: 1, counts: {}, summary: {}, plan: { limit: null, used: 0 } }),
      'GET /stores/S1/ai/generations': ok([photoDone({ status: 'applied', check_edges: false })], cursor),
    });
    renderApp(<AppRoutes />, { route: '/integrations/ai-photos?tab=settings' });
    await userEvent.selectOptions(await screen.findByLabelText('Default background', undefined, SLOW), 'mint');
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/ai_photos', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/ai_photos', 'PATCH')[0]!)).toEqual({ settings: { default_background: 'mint' }, revision: 3 });
    expect(screen.queryByText(/OpenAI|Gemini/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/ai_photos/disconnect', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/ai_photos/disconnect', 'POST')[0]!)).toEqual({ confirm: 'DISCONNECT' });
  });

  it('Photo history lists edits with status pills and credits', async () => {
    signedIn('owner', {
      'GET /stores/S1/integrations/ai_photos': ok(connected('ai_photos', {})),
      'GET /billing/ai-credits': ok(credits()),
      'GET /stores/S1/ai/generations': ok([photoDone({ status: 'applied' }), photoEdit({ id: 'G10', status: 'failed', refunded: true, error_code: 'image_unsupported' }), photoDone({ id: 'G11', check_edges: true })], cursor),
    });
    renderApp(<AppRoutes />, { route: '/integrations/ai-photos?tab=history' });
    const table = await screen.findByRole('region', { name: 'Photo history' }, SLOW);
    expect(await within(table).findByText('Saved')).toBeInTheDocument();
    expect(within(table).getByText('Failed · free')).toBeInTheDocument();
    expect(within(table).getByText('Check edges')).toBeInTheDocument();
    expect(within(table).getAllByText('Background · studio white')).toHaveLength(3);
  });
});

const editorRoutes = (extra: Record<string, Response | ((init: RequestInit) => Response)> = {}) => ({
  'GET /stores/S1/products/P1': ok(productWithPhoto()),
  'GET /stores/S1/categories': ok([]),
  'GET /stores/S1/integrations/ai_writer': ok(connected('ai_writer', {})),
  'GET /stores/S1/integrations/ai_photos': ok(integration('ai_photos', { status: 'disconnected' })),
  'GET /billing/ai-credits': ok(credits()),
  ...extra,
});

describe('PHASE-8-9D Write with AI in the product editor (2141:59985 / 2141:60490)', () => {
  it('hidden while Claude is Off (P89D-2)', async () => {
    signedIn('owner', editorRoutes({ 'GET /stores/S1/integrations/ai_writer': ok(integration('ai_writer')) }));
    renderApp(<AppRoutes />, { route: '/products/P1' });
    await screen.findByLabelText('Product name', {}, SLOW);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Write with AI' })).not.toBeInTheDocument());
  });

  it('queued → drafts → Insert fills the editor (unsaved; no product write); credits line updates', async () => {
    let polls = 0;
    const fetchMock = signedIn(
      'staff',
      editorRoutes({
        'POST /stores/S1/ai/product-descriptions': accepted(generation()),
        'GET /stores/S1/ai/generations/G1': () => (++polls < 2 ? ok(generation({ status: 'running' })) : ok(drafts())),
      }),
    );
    renderApp(<AppRoutes />, { route: '/products/P1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Write with AI' }, SLOW));
    const panel = screen.getByRole('region', { name: 'Write with AI' });
    await userEvent.type(within(panel).getByLabelText('What should it mention? (optional)'), 'half-silk, Eid');
    await userEvent.click(within(panel).getByRole('button', { name: 'Formal' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Write drafts' }));
    expect(await within(panel).findByText(/Claude is writing two drafts/)).toBeInTheDocument();
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/ai/product-descriptions', 'POST')).toHaveLength(1));
    const call = byMethod(fetchMock, '/stores/S1/ai/product-descriptions', 'POST')[0]!;
    expect(bodyOf(call)).toEqual({ product_id: 'P1', key_points: ['half-silk', 'Eid'], tone: 'professional', length: 'medium', language: 'bn', variants: 2, use_product_image: true });
    expect((call[1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();

    expect(await within(panel).findByText('হাতে বোনা জামদানি থ্রি-পিস।', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(within(panel).getByText(/Draft 1 of 2/)).toBeInTheDocument();
    expect(within(panel).getByTestId('ai-credits-line')).toHaveTextContent('Used 1 credit · 288 left this month');
    await userEvent.click(within(panel).getByRole('button', { name: 'Next draft' }));
    expect(within(panel).getByText('Second draft paragraph.')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Previous draft' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Insert below' }));
    expect(screen.getByLabelText('Page title')).toHaveValue('Jamdani Three-Piece — Red');
    expect(await screen.findAllByText('Unsaved changes')).not.toHaveLength(0);
    expect(byMethod(fetchMock, '/stores/S1/products/P1', 'PATCH')).toHaveLength(0);
  });

  it('credits exhausted: actions disabled with the banner; a 402 shows needed / available / reset date', async () => {
    signedIn('owner', editorRoutes({ 'GET /billing/ai-credits': ok(noCredits()) }));
    renderApp(<AppRoutes />, { route: '/products/P1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Write with AI' }, SLOW));
    const panel = screen.getByRole('region', { name: 'Write with AI' });
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/have 0 left\. Your credits reset on 1 Dec 2026/);
    expect(within(panel).getByRole('button', { name: 'Write drafts' })).toBeDisabled();
  });

  it('402 ai_credits_exhausted from the API shows the exhausted state', async () => {
    signedIn('owner', editorRoutes({ 'POST /stores/S1/ai/product-descriptions': err(402, 'ai_credits_exhausted', { needed: 1, available: 0, resets_at: '2026-12-01T00:00:00Z' }) }));
    renderApp(<AppRoutes />, { route: '/products/P1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Write with AI' }, SLOW));
    const panel = screen.getByRole('region', { name: 'Write with AI' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Write drafts' }));
    expect(await within(panel).findByText(/You need 1 credit and have 0 left/)).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Write drafts' })).toBeDisabled());
  });

  it('a failed generation says the credit was returned', async () => {
    signedIn('owner', editorRoutes({ 'POST /stores/S1/ai/product-descriptions': accepted(generation()), 'GET /stores/S1/ai/generations/G1': ok(generation({ status: 'failed', refunded: true, error_code: 'ai_refused' })) }));
    renderApp(<AppRoutes />, { route: '/products/P1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Write with AI' }, SLOW));
    const panel = screen.getByRole('region', { name: 'Write with AI' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Write drafts' }));
    expect(await within(panel).findByText(/Claude couldn’t write this one.*Your credit was returned/)).toBeInTheDocument();
  });
});

describe('PHASE-8-9D AI photos in the product editor (2135:55033)', () => {
  it('preset → before / after → Save to product (replace in place) → Undo', async () => {
    let state: 'done' | 'applied' | 'undone' = 'done';
    const fetchMock = signedIn(
      'owner',
      editorRoutes({
        'GET /stores/S1/integrations/ai_photos': ok(connected('ai_photos', {})),
        'POST /stores/S1/ai/photo-edits': accepted(photoEdit({ status: 'queued' })),
        'GET /stores/S1/ai/generations/G9': () => ok(state === 'done' ? photoDone() : state === 'applied' ? photoDone({ status: 'applied', original_kept_until: '2099-01-01T00:00:00Z' }) : photoDone({ status: 'undone' })),
        'POST /stores/S1/ai/photo-edits/G9/apply': () => {
          state = 'applied';
          return ok(photoDone({ status: 'applied', original_kept_until: '2099-01-01T00:00:00Z' }));
        },
        'POST /stores/S1/ai/photo-edits/G9/undo': () => {
          state = 'undone';
          return ok(photoDone({ status: 'undone' }));
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/products/P1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit with AI' }, SLOW));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Mint' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit photo · 2 credits' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/ai/photo-edits', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/ai/photo-edits', 'POST')[0]!)).toEqual({ media_id: 'M1', product_id: 'P1', operation: 'replace_background', background: 'mint' });
    expect(await within(dialog).findByRole('img', { name: 'Edited' })).toHaveAttribute('src', 'https://cdn.test/m2.jpg');
    expect(within(dialog).getByRole('img', { name: 'Original' })).toHaveAttribute('src', 'https://cdn.test/m1.jpg');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save to product' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/ai/photo-edits/G9/apply', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/ai/photo-edits/G9/apply', 'POST')[0]!)).toEqual({ product_id: 'P1', replace_image_id: 'M1' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/ai/photo-edits/G9/undo', 'POST')).toHaveLength(1));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/products/P1').length).toBeGreaterThanOrEqual(3));
  });
});
