import { isApiError, isImpersonationReadOnly } from '@storeplix/api-client';
import {
  AI_CREDIT_COSTS,
  type AiCreditsExhaustedDetails,
  type AiCreditsSummary,
  type AiErrorCode,
  type AiGeneration,
  type AiIntegrationProvider,
  type AiLength,
  type AiPhotoBackground,
  type AiTone,
  type ProductDescriptionVariant,
  type RichTextBlock,
  type RichTextDoc,
} from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { errorMessage } from '../catalog/states';
import { READ_ONLY_MESSAGE } from '../impersonation/ApiErrorWatcher';
import { hasPermission, type PermissionHolder } from '../lib/permissions';
import { formatDate } from '../plan/billing';

// PHASE-8-9D part B (WEB): pure helpers for the AI tools — Claude product descriptions (`ai_writer`, Figma 31:5788 and
// the editor panel 2141:60490) and AI product photos (`ai_photos`, 2135:55033) — and the shared AI credit pool (§10).
// AI output is never auto-saved (P89D-52): helpers only build editor values; the merchant saves the product.

export const AI_SLUG: Record<AiIntegrationProvider, string> = { ai_writer: 'claude', ai_photos: 'ai-photos' };
export const AI_PROVIDER_BY_SLUG: Record<string, AiIntegrationProvider> = { claude: 'ai_writer', 'ai-photos': 'ai_photos' };
export const aiPath = (p: AiIntegrationProvider) => `/integrations/${AI_SLUG[p]}`;
export const AI_ORDER: AiIntegrationProvider[] = ['ai_writer', 'ai_photos'];

export interface AiMeta {
  name: string;
  short: string;
  typePill: string;
  description: string;
  capability: string;
  historyLabel: string;
}

export const AI_META: Record<AiIntegrationProvider, AiMeta> = {
  ai_writer: {
    name: 'Claude by Anthropic',
    short: 'Claude',
    typePill: 'AI provider',
    description: 'Writes Bangla and English product descriptions, SEO titles and meta descriptions from your product and a few words. You check the draft and save it.',
    capability: 'Product descriptions in Bangla and English',
    historyLabel: 'History',
  },
  ai_photos: {
    name: 'AI product photos',
    short: 'AI photos',
    typePill: 'AI tool',
    description: 'Turn phone photos into clean shop photos: remove the background or put the product on a studio background. The product itself is never redrawn.',
    capability: 'Remove or replace photo backgrounds',
    historyLabel: 'Photo history',
  },
};

// ---------- Permissions (P89D-41) ----------

/** Generate / apply / undo / history: `products.edit` (plus the tool being On). */
export const canUseAi = (m: PermissionHolder) => hasPermission(m, 'products.edit');
/** AI credits read: `products.edit | integrations.manage | billing.view`. */
export const canReadAiCredits = (m: PermissionHolder) => hasPermission(m, 'products.edit') || hasPermission(m, 'integrations.manage') || hasPermission(m, 'billing.view');
/** The AI tool pages: readable by members who can manage/see integrations or use the tools. */
export const canViewAiPage = (m: PermissionHolder) => hasPermission(m, 'integrations.manage') || hasPermission(m, 'marketing.manage') || hasPermission(m, 'products.edit');

// ---------- Labels ----------

/** Figma chips Warm / Formal / Playful (+ Premium, the fourth contract tone). */
export const TONES: AiTone[] = ['friendly', 'professional', 'playful', 'premium'];
export const toneLabel: Record<AiTone, string> = { friendly: 'Warm', professional: 'Formal', playful: 'Playful', premium: 'Premium' };
export const LENGTHS: AiLength[] = ['short', 'medium', 'long'];
export const lengthLabel: Record<AiLength, string> = { short: 'Short', medium: 'Medium', long: 'Long' };
export type AiLanguage = 'bn' | 'en';
export const LANGUAGES: AiLanguage[] = ['bn', 'en'];
export const languageLabel: Record<AiLanguage, string> = { bn: 'বাংলা', en: 'English' };

export const backgroundLabel: Record<AiPhotoBackground, string> = {
  studio_white: 'Studio white',
  soft_grey: 'Soft grey',
  warm_beige: 'Warm beige',
  pastel_pink: 'Pastel pink',
  mint: 'Mint',
  transparent: 'No background',
};

/** Swatch classes (tokens only). */
export const backgroundSwatch: Record<AiPhotoBackground, string> = {
  studio_white: 'bg-surface-card',
  soft_grey: 'bg-surface-subtle',
  warm_beige: 'bg-warning-bg',
  pastel_pink: 'bg-accent-100',
  mint: 'bg-success-bg',
  transparent: 'bg-[repeating-conic-gradient(var(--color-border-default)_0%_25%,var(--color-surface-card)_0%_50%)] bg-[length:12px_12px]',
};

/** `transparent` = remove the background; every other preset replaces it (presets only, P89D-57). */
export function photoEditInput(mediaId: string, productId: string | null, background: AiPhotoBackground) {
  return background === 'transparent'
    ? { media_id: mediaId, product_id: productId, operation: 'remove_background' as const, background: null }
    : { media_id: mediaId, product_id: productId, operation: 'replace_background' as const, background };
}

export function photoEditLabel(g: Pick<AiGeneration, 'input'>): string {
  const input = g.input as { operation?: string; background?: AiPhotoBackground | null };
  if (input.operation === 'remove_background') return 'Background removed';
  return input.background ? `Background · ${backgroundLabel[input.background].toLowerCase()}` : 'Background replaced';
}

// ---------- Generations ----------

/** Settings a merchant may write: the API refuses read-only keys (P89D-4), e.g. `keep_originals_days` (fixed 30). */
const AI_READ_ONLY_SETTINGS: Record<AiIntegrationProvider, readonly string[]> = { ai_writer: [], ai_photos: ['keep_originals_days'] };
export function writableAiSettings(provider: AiIntegrationProvider, settings: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([k]) => !AI_READ_ONLY_SETTINGS[provider].includes(k)));
}

export const isWorking = (g: Pick<AiGeneration, 'status'> | null | undefined) => !!g && (g.status === 'queued' || g.status === 'running');
/** Poll every AI_GENERATION_POLL_MS; stop after 2 minutes with a retry message (P89D-51). */
export const POLL_LIMIT_MS = 120_000;

export function generationErrorText(code: AiErrorCode | null): string {
  switch (code) {
    case 'ai_refused':
      return 'Claude couldn’t write this one. Change the details and try again.';
    case 'ai_timeout':
      return 'The AI took too long to answer. Try again.';
    case 'ai_output_invalid':
      return 'The draft didn’t come out right. Try again.';
    case 'image_unsupported':
      return 'This photo can’t be edited. Use a JPG, PNG or WebP of at least 300 px, up to 10 MB.';
    case 'ai_unavailable':
    case 'provider_error':
    default:
      return 'The AI service didn’t answer. Try again in a few minutes.';
  }
}

/** Recent photo edits / history status pill (Figma: Saved / Check edges / Undone / Failed · free). */
export function generationStatusMeta(g: Pick<AiGeneration, 'status' | 'check_edges' | 'kind'>): { label: string; tone: BadgeTone } {
  switch (g.status) {
    case 'queued':
    case 'running':
      return { label: 'Working…', tone: 'info' };
    case 'failed':
      return { label: 'Failed · free', tone: 'danger' };
    case 'applied':
      return { label: 'Saved', tone: 'success' };
    case 'undone':
      return { label: 'Undone', tone: 'neutral' };
    case 'succeeded':
      if (g.kind === 'photo_edit' && g.check_edges) return { label: 'Check edges', tone: 'warning' };
      return { label: g.kind === 'photo_edit' ? 'Not saved' : 'Ready', tone: 'neutral' };
  }
}

export const creditsCell = (g: Pick<AiGeneration, 'credits' | 'refunded' | 'status'>) => (g.refunded || g.status === 'failed' ? '—' : String(g.credits));

/** Undo is possible on an applied photo edit while the original is kept (30 days, P89D-58). */
export function canUndo(g: Pick<AiGeneration, 'status' | 'original_kept_until'>, now = Date.now()): boolean {
  if (g.status !== 'applied') return false;
  if (!g.original_kept_until) return true;
  const t = Date.parse(g.original_kept_until);
  return Number.isNaN(t) || t > now;
}

// ---------- Credits (§10) ----------

export const creditWord = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'credit' : 'credits'}`;

/** "3,418 left this month" line under the writer and on the AI pages. */
export function creditsLeftLine(c: AiCreditsSummary): string {
  const bonus = c.bonus > 0 ? ` · ${c.bonus.toLocaleString('en-US')} bonus` : '';
  return `${c.available.toLocaleString('en-US')} left this month${bonus}`;
}

export const hasCreditsFor = (c: AiCreditsSummary | undefined, kind: keyof typeof AI_CREDIT_COSTS) => !c || c.available >= (c.costs?.[kind] ?? AI_CREDIT_COSTS[kind]);

/** Low = 10 % or less of the allowance left (Figma running-low state 2142:58681). */
export function creditsLevel(c: AiCreditsSummary): 'ok' | 'low' | 'out' {
  if (c.available <= 0) return 'out';
  const limit = c.allowance.limit;
  if (limit && limit > 0 && c.available <= Math.ceil(limit * 0.1)) return 'low';
  return 'ok';
}

/**
 * Credits reset at midnight in the store's timezone (the API sends UTC); show that calendar day whatever the browser's
 * zone is. Asia/Dhaka is the API's fallback before a store exists.
 */
export const AI_CREDITS_DEFAULT_TZ = 'Asia/Dhaka';
export const resetsText = (iso: string, timeZone?: string | null) => `resets ${formatDate(iso, { short: true, timeZone: timeZone || AI_CREDITS_DEFAULT_TZ })}`;

export function exhaustedDetails(e: unknown): AiCreditsExhaustedDetails | null {
  if (!isApiError(e) || e.code !== 'ai_credits_exhausted') return null;
  const d = e.details ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { needed: num(d.needed), available: num(d.available), resets_at: typeof d.resets_at === 'string' ? d.resets_at : '' };
}

export function exhaustedText(d: Pick<AiCreditsExhaustedDetails, 'needed' | 'available' | 'resets_at'>, timeZone?: string | null): string {
  const reset = d.resets_at ? ` Your credits reset on ${formatDate(d.resets_at, { timeZone: timeZone || AI_CREDITS_DEFAULT_TZ })}.` : '';
  return `You need ${creditWord(d.needed)} and have ${d.available.toLocaleString('en-US')} left.${reset} AI tools pause until then — the rest of your shop keeps working.`;
}

// ---------- Errors (§13.2) ----------

export function aiErrorText(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (isImpersonationReadOnly(error)) return READ_ONLY_MESSAGE;
  if (!isApiError(error)) return errorMessage(error, fallback);
  switch (error.code) {
    case 'ai_credits_exhausted': {
      const d = exhaustedDetails(error);
      return d ? exhaustedText(d) : 'You’ve used all your AI credits for this month.';
    }
    case 'ai_integration_off':
      return 'This AI tool is turned off. Turn it on in Integrations › AI for growth.';
    case 'ai_generation_not_applicable':
      return 'This edit can’t be saved or undone any more. Refresh and try again.';
    case 'rate_limited':
      return 'Too many AI requests. Wait a minute and try again.';
    case 'revision_conflict':
      return 'Someone else changed these settings. We loaded the latest version — try again.';
    case 'confirmation_mismatch':
      return 'Type DISCONNECT in capital letters to confirm.';
    default:
      return error.message || fallback;
  }
}

// ---------- Writer output → editor values (P89D-52, P89D-53) ----------

/** Key points: one per line or comma, ≤ 10 × 200 chars (P89D-38). */
export function parseKeyPoints(raw: string): string[] {
  return raw
    .split(/[\n,،]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((s) => s.slice(0, 200));
}

/** Plain strings only (the API already stripped markup); never HTML into the editor. */
export function variantBlocks(v: Pick<ProductDescriptionVariant, 'paragraphs' | 'highlights'>): RichTextBlock[] {
  const blocks: RichTextBlock[] = v.paragraphs.filter((p) => p.trim()).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p.trim() }] }));
  const items = v.highlights.filter((h) => h.trim());
  if (items.length) blocks.push({ type: 'bulletList', content: items.map((h) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: h.trim() }] }] })) });
  return blocks;
}

export const variantToDoc = (v: Pick<ProductDescriptionVariant, 'paragraphs' | 'highlights'>): RichTextDoc => ({ type: 'doc', content: variantBlocks(v) });

const isEmptyDoc = (d: RichTextDoc | null) => !d || d.content.every((b) => b.type === 'paragraph' && !(b.content ?? []).length);

/** "Insert below": keep what the merchant wrote, add the draft under it. */
export function appendVariant(current: RichTextDoc | null, v: Pick<ProductDescriptionVariant, 'paragraphs' | 'highlights'>): RichTextDoc {
  if (isEmptyDoc(current)) return variantToDoc(v);
  return { type: 'doc', content: [...current!.content, ...variantBlocks(v)] };
}
