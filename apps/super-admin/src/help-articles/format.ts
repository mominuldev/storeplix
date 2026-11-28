import type { AdminHelpArticleSummary, HelpArticleStatus, HelpCategoryIcon, UserRef } from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { BarChart3, Box, CreditCard, Globe, Megaphone, MessageCircle, Palette, Rocket, Settings, ShoppingCart, Truck, Users, type LucideIcon } from 'lucide-react';

const TZ = 'Asia/Dhaka';
const dayMonth = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** "12 Nov" or "Today" (Dhaka calendar day). */
export function shortDay(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return dayKey.format(d) === dayKey.format(now) ? 'Today' : dayMonth.format(d);
}

/** "Nusrat J." */
export function shortName(user: Pick<UserRef, 'name'> | null | undefined): string {
  if (!user?.name) return '';
  const [first, ...rest] = user.name.trim().split(/\s+/);
  const last = rest.at(-1);
  return last ? `${first} ${last[0]!.toUpperCase()}.` : (first ?? '');
}

/** Status pill (2134:10410): Published success, Draft neutral, Scheduled {date} info, Archived neutral. */
export function articleStatusMeta(status: HelpArticleStatus, scheduledAt: string | null): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'published':
      return { label: 'Published', tone: 'success' };
    case 'scheduled':
      return { label: scheduledAt ? `Scheduled ${dayMonth.format(new Date(scheduledAt))}` : 'Scheduled', tone: 'info' };
    case 'archived':
      return { label: 'Archived', tone: 'neutral' };
    default:
      return { label: 'Draft', tone: 'neutral' };
  }
}

/** "92% · 232"; amber under 70 % (Figma footnote). */
export function helpfulCell(h: AdminHelpArticleSummary['helpful']): { text: string; low: boolean } {
  if (h.percent === null || h.votes === 0) return { text: '—', low: false };
  return { text: `${Math.round(h.percent)}% · ${h.votes.toLocaleString('en-US')}`, low: h.percent < 70 };
}

export const HELP_ICON: Record<HelpCategoryIcon, LucideIcon> = {
  rocket: Rocket,
  box: Box,
  cart: ShoppingCart,
  truck: Truck,
  card: CreditCard,
  palette: Palette,
  megaphone: Megaphone,
  globe: Globe,
  users: Users,
  chart: BarChart3,
  settings: Settings,
  message: MessageCircle,
};

/** Dhaka wall-clock `YYYY-MM-DDTHH:mm` (datetime-local) ↔ UTC ISO. Bangladesh has no DST (UTC+6). */
export function dhakaLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const d = new Date(`${local}:00+06:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoToDhakaLocal(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 6 * 3600_000);
  return d.toISOString().slice(0, 16);
}

/** "2 min ago" style relative time for "Draft saved …". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return shortDay(iso, new Date(now));
}
