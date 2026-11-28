import type { HelpLanguage, HelpSearchLanguage, SupportAttachment, SupportTicket, SupportTicketMessage, SupportTicketStatus, SupportTicketTab } from '@storeplix/types';
import { SUPPORT_ATTACHMENT_MIMES, SUPPORT_LIMITS, SUPPORT_TICKET_STATUS_LABELS } from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { can, type PermissionHolder } from '../lib/permissions';

// PHASE-8-9C §13 pure rules for Help & support: permissions, article language (URL + per-browser memory), search URL
// state, ticket labels/tones, durations, attachment checks and the thread's system rows. The API stays authoritative.

// ----- Permissions (§2.1, P89C-13) -----
/** Tickets, replies, ratings and uploads: `support.manage`. Guides need no key. */
export const canContactSupport = (m: PermissionHolder) => can.manageSupport(m);
/** Related order picker and order card: `orders.view` (P89C-14). */
export const canLinkOrders = (m: PermissionHolder) => can.has(m, 'orders.view');

// ----- Article language (`?lang=bn`, remembered per browser) -----
export const HELP_LANG_KEY = 'storeplix.help.lang';

export function storedHelpLanguage(): HelpLanguage {
  try {
    return localStorage.getItem(HELP_LANG_KEY) === 'bn' ? 'bn' : 'en';
  } catch {
    return 'en';
  }
}

export function rememberHelpLanguage(lang: HelpLanguage): void {
  try {
    localStorage.setItem(HELP_LANG_KEY, lang);
  } catch {
    // storage blocked: the URL still carries the choice
  }
}

/** `?lang=` wins; otherwise the remembered choice (default English). */
export function resolveHelpLanguage(param: string | null): HelpLanguage {
  if (param === 'bn' || param === 'en') return param;
  return storedHelpLanguage();
}

export const FALLBACK_NOTE: Record<HelpLanguage, string> = {
  bn: 'এই লেখাটি এখনো বাংলায় নেই — ইংরেজিতে দেখানো হচ্ছে।',
  en: 'Not available in বাংলা yet — showing English.',
};

// ----- Search (`/help?q=&language=&category=`) -----
export interface HelpSearchState {
  q: string;
  language: HelpSearchLanguage;
  category: string | null;
}

export function parseHelpSearch(p: URLSearchParams): HelpSearchState {
  const lang = p.get('language');
  return {
    q: (p.get('q') ?? '').slice(0, 100),
    language: lang === 'en' || lang === 'bn' ? lang : 'both',
    category: p.get('category') || null,
  };
}

export function helpSearchParams(s: HelpSearchState): URLSearchParams {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.language !== 'both') p.set('language', s.language);
  if (s.category) p.set('category', s.category);
  return p;
}

/** Query length rule (P89C-8): 2–100 characters after trimming. */
export const isSearchable = (q: string) => q.trim().length >= 2 && q.trim().length <= 100;

/** Splits `text` into plain/bold parts on the query's words (the UI bolds terms; the API never sends HTML). */
export function highlightParts(text: string, q: string): { text: string; hit: boolean }[] {
  const terms = [...new Set(q.trim().split(/\s+/).filter((w) => w.length >= 2))].sort((a, b) => b.length - a.length);
  if (!terms.length || !text) return [{ text, hit: false }];
  const escaped = terms.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'giu');
  return text
    .split(re)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, hit: terms.some((t) => t.toLocaleLowerCase() === part.toLocaleLowerCase()) }));
}

// ----- Dates (Asia/Dhaka) -----
const DHAKA = 'Asia/Dhaka';

export function formatHelpDate(iso: string | null | undefined, opts: { year?: boolean } = {}): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(opts.year ? { year: 'numeric' } : {}), timeZone: DHAKA });
}

export function formatHelpTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: DHAKA });
}

export function formatHelpDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return `${formatHelpDate(iso)}, ${formatHelpTime(iso)}`;
}

/** "Today, 18 Nov" / "18 Nov 2025" — thread day separators. */
export function dayLabel(iso: string, now = Date.now()): string {
  const key = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: DHAKA });
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  if (key(t) === key(now)) return `Today, ${formatHelpDate(iso)}`;
  if (key(t) === key(now - 86_400_000)) return `Yesterday, ${formatHelpDate(iso)}`;
  return formatHelpDate(iso, { year: new Date(t).getUTCFullYear() !== new Date(now).getUTCFullYear() });
}

/** "12 min ago", "3 h ago", "Yesterday", "14 Nov". */
export function agoLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 2 * 86_400_000) return 'Yesterday';
  return formatHelpDate(iso);
}

/** Seconds → "45 s", "6 min", "2 h 5 min", "3 d". Null → "—". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} d`;
}

// ----- Tickets -----
export const TICKET_STATUS_TONES: Record<SupportTicketStatus, BadgeTone> = {
  open: 'info',
  awaiting_merchant: 'warning',
  awaiting_support: 'info',
  resolved: 'success',
  closed: 'neutral',
};
export const ticketStatusLabel = (s: SupportTicketStatus) => SUPPORT_TICKET_STATUS_LABELS[s];

export const PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' } as const;
export const PRIORITY_TONES: Record<keyof typeof PRIORITY_LABELS, BadgeTone> = { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' };

export const TICKET_TABS: readonly SupportTicketTab[] = ['all', 'open', 'waiting_on_you', 'solved'];
export const TICKET_TAB_LABELS: Record<SupportTicketTab, string> = { all: 'All', open: 'Open', waiting_on_you: 'Waiting on you', solved: 'Solved' };
export const parseTicketTab = (v: string | null): SupportTicketTab => ((TICKET_TABS as readonly string[]).includes(v ?? '') ? (v as SupportTicketTab) : 'all');

/** "T-1234" or "1234" → the number, else the subject text (both go to `filter[q]`). */
export const normalizeTicketQuery = (q: string) => q.trim();

/** Client checks before upload (S255; the API re-checks): JPG/PNG/PDF, ≤ 10 MB, ≤ 5 per message. */
export function attachmentProblem(file: { name: string; type: string; size: number }, alreadyAttached: number): string | null {
  if (alreadyAttached >= SUPPORT_LIMITS.attachmentsPerMessage) return `You can attach up to ${SUPPORT_LIMITS.attachmentsPerMessage} files.`;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const typeOk = (SUPPORT_ATTACHMENT_MIMES as readonly string[]).includes(file.type) || (!file.type && ['jpg', 'jpeg', 'png', 'pdf'].includes(ext));
  if (!typeOk) return 'Only JPG, PNG or PDF files.';
  if (file.size > SUPPORT_LIMITS.attachmentBytes) return 'Files must be 10 MB or smaller.';
  return null;
}

export const ATTACHMENT_ACCEPT = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const attachmentMeta = (a: SupportAttachment) => `${a.kind === 'pdf' ? 'PDF' : 'Image'} · ${formatBytes(a.size_bytes)}`;

/** System row copy (§13): "Picked up by Farhana", "Marked solved", "Reopened", "Closed automatically". */
export function systemRowText(m: SupportTicketMessage): string | null {
  const s = m.system;
  if (!s) return null;
  switch (s.event) {
    case 'created':
      return `Ticket opened${s.actor_name ? ` by ${s.actor_name}` : ''}`;
    case 'assigned':
      return s.actor_name ? `Picked up by ${s.actor_name} from Store Plix support` : 'Picked up by Store Plix support';
    case 'status_changed':
      if (s.status === 'resolved') return `${s.actor_name ? `${s.actor_name} marked` : 'Marked'} this ticket as Solved`;
      if (s.status === 'closed') return 'Ticket closed';
      return s.status ? `Status changed to ${ticketStatusLabel(s.status)}` : 'Status changed';
    case 'reopened':
      return 'Reopened';
    case 'auto_closed':
      return 'Closed automatically';
    default:
      return null; // unassigned / priority / category / rated: staff-side only
  }
}

/** Polling merge: keep the newest server list, plus optimistic rows not yet echoed (by id). */
export function mergeMessages(server: SupportTicketMessage[], pending: SupportTicketMessage[]): SupportTicketMessage[] {
  const ids = new Set(server.map((m) => m.id));
  return [...server, ...pending.filter((p) => !ids.has(p.id))];
}

/** Rating card visible when the API allows it or a rating exists (read-only after the window). */
export const showRatingCard = (t: Pick<SupportTicket, 'can' | 'rating' | 'status'>) => t.can.rate || (!!t.rating && (t.status === 'resolved' || t.status === 'closed'));

export const newClientId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
