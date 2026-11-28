import type { AiCreditsSummary, AiGeneration, PaymentGatewayAccount } from '@storeplix/types';

// PHASE-8-9D part B fixtures (Nagad gateway, AI credits, AI generations).

export function nagad(o: Partial<PaymentGatewayAccount> = {}): PaymentGatewayAccount {
  return {
    provider: 'nagad',
    status: 'not_connected',
    mode: null,
    credentials_hint: null,
    enabled: false,
    is_default: false,
    verified_at: null,
    last_checked_at: null,
    last_error_code: null,
    connected_by: null,
    connected_at: null,
    revision: 0,
    capabilities: ['query', 'webhook'],
    callback_url: null,
    ...o,
  };
}

export const nagadConnected = (o: Partial<PaymentGatewayAccount> = {}) =>
  nagad({
    status: 'connected',
    mode: 'live',
    credentials_hint: '••••4225',
    enabled: true,
    verified_at: '2026-11-24T08:00:00Z',
    connected_at: '2026-11-24T07:00:00Z',
    connected_by: { id: 'U1', name: 'Rafiqul Islam' } as PaymentGatewayAccount['connected_by'],
    revision: 4,
    callback_url: 'https://api.storeplix.com/api/v1/payments/return/nagad',
    ...o,
  });

export function credits(o: Partial<AiCreditsSummary> = {}): AiCreditsSummary {
  return {
    allowance: { limit: 300, used: 12, remaining: 288, resets_at: '2026-12-01T00:00:00+06:00' },
    bonus: 0,
    available: 288,
    costs: { product_description: 1, photo_edit: 2 },
    ...o,
  };
}

export const noCredits = () => credits({ allowance: { limit: 20, used: 20, remaining: 0, resets_at: '2026-12-01T00:00:00+06:00' }, available: 0 });

export function generation(o: Partial<AiGeneration> = {}): AiGeneration {
  return {
    id: 'G1',
    kind: 'product_description',
    status: 'queued',
    product: { id: 'P1', name: 'Jamdani Three-Piece' },
    credits: 1,
    charged_from: 'allowance',
    refunded: false,
    input: { product_id: 'P1', language: 'bn', tone: 'friendly', length: 'medium', variants: 2 },
    variants: null,
    source_image: null,
    result_image: null,
    check_edges: false,
    error_code: null,
    requested_by: { id: 'U1', name: 'Rahim Ahmed' } as AiGeneration['requested_by'],
    created_at: '2026-11-28T08:00:00Z',
    finished_at: null,
    applied_at: null,
    undone_at: null,
    original_kept_until: null,
    ...o,
  };
}

export const drafts = () =>
  generation({
    status: 'succeeded',
    finished_at: '2026-11-28T08:00:05Z',
    variants: [
      { description_html: '<p>হাতে বোনা জামদানি</p>', paragraphs: ['হাতে বোনা জামদানি থ্রি-পিস।'], highlights: ['কামিজের দৈর্ঘ্য ৪৪"'], seo_title: 'Jamdani Three-Piece — Red', meta_description: 'Handwoven Dhakai jamdani.' },
      { description_html: '<p>Second</p>', paragraphs: ['Second draft paragraph.'], highlights: [], seo_title: null, meta_description: null },
    ],
  });

const media = (id: string, url: string) => ({ id, url, width: 1200, height: 1200, alt: null, srcset: [] });

export const photoEdit = (o: Partial<AiGeneration> = {}) =>
  generation({
    id: 'G9',
    kind: 'photo_edit',
    credits: 2,
    input: { media_id: 'M1', product_id: 'P1', operation: 'replace_background', background: 'studio_white' },
    source_image: media('M1', 'https://cdn.test/m1.jpg'),
    ...o,
  });

export const photoDone = (o: Partial<AiGeneration> = {}) => photoEdit({ status: 'succeeded', result_image: media('M2', 'https://cdn.test/m2.jpg'), finished_at: '2026-11-28T08:00:09Z', ...o });
