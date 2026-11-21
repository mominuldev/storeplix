import 'server-only';
import { cookies } from 'next/headers';
import { EMBED_COOKIE, PREVIEW_COOKIE, sanitizePreviewToken } from './preview-token';

/** The httpOnly preview cookie, read server-side only. Never passed to client components. */
export async function getPreviewToken(): Promise<string | null> {
  const jar = await cookies();
  return sanitizePreviewToken(jar.get(PREVIEW_COOKIE)?.value);
}

/** True when the preview was opened by the dashboard editor iframe (`?preview=…&embed=1`). */
export async function isEmbeddedPreview(): Promise<boolean> {
  const jar = await cookies();
  return jar.get(EMBED_COOKIE)?.value === '1';
}
