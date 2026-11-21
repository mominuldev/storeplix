import type { EditorToPreviewMessage, PreviewToEditorMessage } from '@storeplix/types';
import { z } from 'zod';

// Contract §5.3 / §6: editor ↔ preview postMessage. Outgoing messages use the exact preview origin as
// targetOrigin (never `*`); incoming ones are accepted only from the iframe's window, from the exact preview
// origin, and when they parse as a PreviewToEditorMessage. Messages never carry tokens or config.

const base = { source: z.literal('storeplix-preview'), v: z.literal(1) };
const sectionId = z.string().regex(/^[a-z0-9-]{1,64}$/);
const path = z.string().max(2048).startsWith('/');

export const previewToEditorSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('ready'), path }),
  z.strictObject({ ...base, type: z.literal('section-click'), section_id: sectionId }),
  z.strictObject({ ...base, type: z.literal('navigated'), path }),
]);

/** Origin of a preview URL, or null when it isn't a valid http(s) URL. */
export function previewOriginOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Validates a `message` event from the preview iframe. Returns null for anything that must be ignored. */
export function readPreviewMessage(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  frame: Window | null | undefined,
  previewOrigin: string | null,
): PreviewToEditorMessage | null {
  if (!frame || !previewOrigin) return null;
  if (event.source !== frame) return null;
  if (event.origin !== previewOrigin) return null;
  const parsed = previewToEditorSchema.safeParse(event.data);
  return parsed.success ? (parsed.data as PreviewToEditorMessage) : null;
}

type Outgoing = EditorToPreviewMessage extends infer M ? (M extends unknown ? Omit<M, 'source' | 'v'> : never) : never;

/** Posts to the iframe with an explicit targetOrigin. No-op without a window or a valid origin. */
export function postToPreview(frame: Window | null | undefined, previewOrigin: string | null, message: Outgoing): boolean {
  if (!frame || !previewOrigin) return false;
  frame.postMessage({ source: 'storeplix-editor', v: 1, ...message } satisfies EditorToPreviewMessage, previewOrigin);
  return true;
}
