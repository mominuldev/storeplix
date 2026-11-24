// PHASE-8-5 §5.3 / P85-18: SMS part counting, mirrored from the API's `SmsParts::count` (the server count is
// authoritative; both sides run `docs/api/sms-parts-vectors.json`). GSM-7 when every character is in the GSM 03.38
// basic set or the extension table (extension characters cost 2 septets); otherwise UCS-2 counted in UTF-16 code
// units. Single part: 160 septets / 70 units; multipart: 153 / 67 per part.

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENSION = '^{}\\[~]|€';

const basic = new Set(Array.from(GSM_BASIC));
const extension = new Set(Array.from(GSM_EXTENSION));

export type SmsEncoding = 'gsm7' | 'ucs2';

export interface SmsCount {
  encoding: SmsEncoding;
  /** Septets (GSM-7) or UTF-16 code units (UCS-2). */
  units: number;
  parts: number;
  /** Capacity of one part at this length (160/153 or 70/67). */
  perPart: number;
  /** Capacity of a single-part message in this encoding (160 or 70). */
  single: number;
}

export function isGsm7(text: string): boolean {
  for (const ch of text) if (!basic.has(ch) && !extension.has(ch)) return false;
  return true;
}

export function smsParts(text: string): SmsCount {
  if (isGsm7(text)) {
    let units = 0;
    for (const ch of text) units += extension.has(ch) ? 2 : 1;
    return count('gsm7', units, 160, 153);
  }
  return count('ucs2', text.length, 70, 67);
}

function count(encoding: SmsEncoding, units: number, single: number, multi: number): SmsCount {
  if (units === 0) return { encoding, units, parts: 0, perPart: single, single };
  if (units <= single) return { encoding, units, parts: 1, perPart: single, single };
  return { encoding, units, parts: Math.ceil(units / multi), perPart: multi, single };
}
