/**
 * Link builders for merchant contact data (Phase 2 contract §4). Each returns a safe href or null,
 * so the UI renders an item only when its link is valid. Values are always rendered as text.
 */

const SOCIAL_HOSTS = {
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com'],
  instagram: ['instagram.com', 'www.instagram.com'],
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
} as const;

export type SocialNetwork = keyof typeof SOCIAL_HOSTS;

/** Phone -> `tel:+8801...`. Keeps a leading + and digits only; 7-15 digits (E.164 length). */
export function telHref(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (!/^\+?[\d\s().-]{7,24}$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return `tel:${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

/** WhatsApp -> `https://wa.me/<digits>` built from digits only (wa.me wants no +, spaces or dashes). */
export function whatsappHref(number: unknown): string | null {
  if (typeof number !== 'string' || !/^\+?[\d\s().-]{7,24}$/.test(number.trim())) return null;
  const digits = number.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? `https://wa.me/${digits}` : null;
}

/** Email -> `mailto:`; a strict shape with no header-injection characters (?, &, %, whitespace, <>). */
export function mailtoHref(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const e = email.trim();
  if (e.length > 254 || !/^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(e)) return null;
  return `mailto:${e}`;
}

/** Social profile URL: https only, no credentials, host on that network's allowlist. */
export function socialHref(network: SocialNetwork, url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 255) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return (SOCIAL_HOSTS[network] as readonly string[]).includes(u.hostname.toLowerCase()) ? u.toString() : null;
  } catch {
    return null;
  }
}
