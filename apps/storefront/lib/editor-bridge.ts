import { z } from 'zod';
import type { EditorToPreviewMessage, PreviewToEditorMessage } from '@storeplix/types';

/**
 * Editor ↔ preview postMessage protocol (PHASE-3-CONTRACT §5.3). Pure helpers shared by the
 * PreviewBridge client component and its tests. Messages never carry tokens, cookies or config.
 */
const SECTION_ID = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const EditorToPreviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ source: z.literal('storeplix-editor'), v: z.literal(1), type: z.literal('refresh') }).strict(),
  z.object({ source: z.literal('storeplix-editor'), v: z.literal(1), type: z.literal('select'), section_id: SECTION_ID.nullable() }).strict(),
  z.object({ source: z.literal('storeplix-editor'), v: z.literal(1), type: z.literal('scroll-to'), section_id: SECTION_ID }).strict(),
]);

export interface IncomingMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

/**
 * Accept a message only if it comes from our parent window, from an exact allowlisted origin, and
 * parses as an EditorToPreviewMessage. Anything else → null (ignored silently).
 */
export function acceptEditorMessage(event: IncomingMessage, parent: unknown, allowedOrigins: readonly string[]): EditorToPreviewMessage | null {
  if (parent === null || parent === undefined || event.source !== parent) return null;
  if (!allowedOrigins.includes(event.origin)) return null;
  const parsed = EditorToPreviewMessageSchema.safeParse(event.data);
  return parsed.success ? (parsed.data as EditorToPreviewMessage) : null;
}

/** targetOrigin for outgoing messages: the exact origin of `document.referrer` if allowlisted, else null (don't post). */
export function referrerTargetOrigin(referrer: string, allowedOrigins: readonly string[]): string | null {
  if (!referrer) return null;
  try {
    const origin = new URL(referrer).origin;
    return allowedOrigins.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

export function previewMessage(m: Omit<Extract<PreviewToEditorMessage, { type: 'ready' }>, 'source' | 'v'>): PreviewToEditorMessage;
export function previewMessage(m: Omit<Extract<PreviewToEditorMessage, { type: 'section-click' }>, 'source' | 'v'>): PreviewToEditorMessage;
export function previewMessage(m: Omit<Extract<PreviewToEditorMessage, { type: 'navigated' }>, 'source' | 'v'>): PreviewToEditorMessage;
export function previewMessage(m: { type: string; path?: string; section_id?: string }): PreviewToEditorMessage {
  return { source: 'storeplix-preview', v: 1, ...m } as PreviewToEditorMessage;
}
