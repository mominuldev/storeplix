import type { SupportTicketPriority, SupportTicketStatus } from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';

/** Staff-facing status labels (the merchant sees "Waiting on you" for awaiting_merchant). */
export const STAFF_STATUS_LABELS: Record<SupportTicketStatus, string> = {
  open: 'New',
  awaiting_support: 'Waiting on us',
  awaiting_merchant: 'Waiting on merchant',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const statusTone: Record<SupportTicketStatus, BadgeTone> = {
  open: 'info',
  awaiting_support: 'warning',
  awaiting_merchant: 'neutral',
  resolved: 'success',
  closed: 'neutral',
};

export const PRIORITY_LABELS: Record<SupportTicketPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const PRIORITIES: SupportTicketPriority[] = ['low', 'normal', 'high', 'urgent'];
export const priorityTone: Record<SupportTicketPriority, BadgeTone> = { low: 'neutral', normal: 'neutral', high: 'info', urgent: 'danger' };

/** "45 s", "14 min", "4 h", "2 d" (+ "3 h 20 min" when `precise`). */
export function duration(seconds: number | null | undefined, precise = false): string {
  if (seconds === null || seconds === undefined || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return precise && m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return precise && h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/**
 * Waiting time (display only, no SLA targets — Q322): amber after 24 h, red after 72 h.
 */
export function waiting(since: string | null | undefined, now = Date.now()): { label: string; tone: BadgeTone } | null {
  if (!since) return null;
  const s = Math.max(0, (now - new Date(since).getTime()) / 1000);
  const tone: BadgeTone = s > 72 * 3600 ? 'danger' : s > 24 * 3600 ? 'warning' : 'neutral';
  return { label: `${duration(s)} waiting`, tone };
}

/** "8m", "1h", "2d" since the last message. */
export function since(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function newClientId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}
