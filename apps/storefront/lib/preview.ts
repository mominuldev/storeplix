import 'server-only';
import { cookies } from 'next/headers';
import { PREVIEW_COOKIE, sanitizePreviewToken } from './preview-token';

/** The httpOnly preview cookie, read server-side only. Never passed to client components. */
export async function getPreviewToken(): Promise<string | null> {
  const jar = await cookies();
  return sanitizePreviewToken(jar.get(PREVIEW_COOKIE)?.value);
}
