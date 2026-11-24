import type { ApiKey, ApiScope, ApiScopeGroup, ApiScopeInfo, FeatureAccess, PermissionKey, WebhookDelivery, WebhookDeliveryErrorCode, WebhookDeliveryStatus, WebhookEndpoint } from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';

// PHASE-8-4 §7 pure helpers (Figma 144:40726): scope tags, scope implication, success pill, delivery pill, plan note.

/** Figma tag tones: writes brand, "· read" info, plain reads ("Products", "Stock") neutral. */
export function scopeTone(scope: ApiScope, label: string): BadgeTone {
  if (scope.endsWith(':write')) return 'brand';
  return label.includes('· read') ? 'info' : 'neutral';
}

const FALLBACK_SCOPE_LABEL: Record<ApiScope, string> = {
  'orders:read': 'Orders · read',
  'orders:write': 'Orders · write',
  'products:read': 'Products',
  'products:write': 'Products · write',
  'inventory:read': 'Stock',
  'inventory:write': 'Stock · write',
  'customers:read': 'Customers · read',
};

export const scopeLabel = (scope: ApiScope, catalogue?: readonly ApiScopeInfo[]) => catalogue?.find((s) => s.key === scope)?.label ?? FALLBACK_SCOPE_LABEL[scope];

/** Tags for the ACCESS column: implied reads are hidden when their write is present (Figma "Orders · write"). */
export function visibleScopes(scopes: readonly ApiScope[]): ApiScope[] {
  const set = new Set(scopes);
  return scopes.filter((s) => !(s.endsWith(':read') && set.has(s.replace(':read', ':write') as ApiScope)));
}

export const groupLabel: Record<ApiScopeGroup, string> = { orders: 'Orders', products: 'Products', inventory: 'Stock', customers: 'Customers' };

/** Scopes grouped by resource, keeping catalogue order. */
export function groupScopes(catalogue: readonly ApiScopeInfo[]): { group: ApiScopeGroup; scopes: ApiScopeInfo[] }[] {
  const out: { group: ApiScopeGroup; scopes: ApiScopeInfo[] }[] = [];
  for (const s of catalogue) {
    const g = out.find((x) => x.group === s.group);
    if (g) g.scopes.push(s);
    else out.push({ group: s.group, scopes: [s] });
  }
  return out;
}

/** Scopes implied by the selected ones (P84 §2.2: a write implies its read). */
export function impliedBy(selected: ReadonlySet<ApiScope>, catalogue: readonly ApiScopeInfo[]): Set<ApiScope> {
  const out = new Set<ApiScope>();
  for (const s of catalogue) if (selected.has(s.key)) for (const i of s.implies) out.add(i);
  return out;
}

/** Toggle one scope: ticking a write ticks its implied reads; an implied read can't be unticked while the write is on. */
export function toggleScope(selected: ReadonlySet<ApiScope>, scope: ApiScope, catalogue: readonly ApiScopeInfo[]): Set<ApiScope> {
  const next = new Set(selected);
  if (next.has(scope)) {
    if (impliedBy(next, catalogue).has(scope)) return next;
    next.delete(scope);
  } else {
    next.add(scope);
    for (const i of catalogue.find((s) => s.key === scope)?.implies ?? []) next.add(i);
  }
  return next;
}

const BACKING_LABEL: Partial<Record<PermissionKey, string>> = {
  'orders.view': 'View orders',
  'orders.process': 'Process orders',
  'products.edit': 'Edit products',
  'inventory.adjust': 'Adjust stock',
  'customers.view': 'View customers',
};

/** Tooltip for a scope the actor can't grant (P84-5 non-delegation). */
export function notGrantableHint(s: Pick<ApiScopeInfo, 'backing_permission'>): string {
  if (!s.backing_permission) return 'You can’t grant this access.';
  return `Your role needs “${BACKING_LABEL[s.backing_permission] ?? s.backing_permission}” to grant this.`;
}

/** "Created 2 Oct by Rafiqul" / "Revoked 12 Nov". */
export function keySubtitle(k: Pick<ApiKey, 'status' | 'created_at' | 'created_by' | 'revoked_at'>): string {
  if (k.status === 'revoked') return `Revoked ${dayMonth(k.revoked_at)}`.trim();
  const by = k.created_by?.name.split(' ')[0];
  return `Created ${dayMonth(k.created_at)}${by ? ` by ${by}` : ''}`;
}

/** "2 Oct". */
export function dayMonth(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "3 Dec 2026". */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  408: 'Request timeout',
  410: 'Gone',
  429: 'Too many requests',
  500: 'Server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout',
};

/** "200 OK", "503 Service unavailable". */
export const httpStatusText = (code: number) => `${code}${REASONS[code] ? ` ${REASONS[code]}` : ''}`;

export const deliveryErrorLabel: Record<WebhookDeliveryErrorCode, string> = {
  timeout: 'Timeout',
  connection_failed: 'No connection',
  url_not_allowed: 'URL blocked',
  http_error: 'HTTP error',
  plan: 'Plan',
  endpoint_disabled: 'Endpoint off',
};

export const deliveryStatusLabel: Record<WebhookDeliveryStatus, string> = { pending: 'Pending', retrying: 'Retrying', succeeded: 'Delivered', failed: 'Failed' };

const is2xx = (n: number | null | undefined) => n !== null && n !== undefined && n >= 200 && n < 300;

/** Recent-deliveries pill: the HTTP code (green 2xx, red otherwise), else the error, else the state. */
export function deliveryPill(d: Pick<WebhookDelivery, 'status' | 'response_status' | 'error_code'>): { label: string; tone: BadgeTone } {
  if (d.response_status !== null) return { label: String(d.response_status), tone: is2xx(d.response_status) ? 'success' : 'danger' };
  if (d.error_code) return { label: deliveryErrorLabel[d.error_code], tone: 'danger' };
  if (d.status === 'succeeded') return { label: 'OK', tone: 'success' };
  if (d.status === 'failed') return { label: 'Failed', tone: 'danger' };
  return { label: deliveryStatusLabel[d.status], tone: d.status === 'retrying' ? 'warning' : 'neutral' };
}

const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

/** SUCCESS · 7 DAYS pill: green ≥ 95, amber ≥ 80, red "<n>% · failing" while failing (else red below 80). */
export function successPill(e: Pick<WebhookEndpoint, 'success_rate_7d' | 'failing_since'>): { label: string; tone: BadgeTone } {
  const r = e.success_rate_7d;
  if (r === null) return { label: e.failing_since ? 'Failing' : 'No data', tone: e.failing_since ? 'danger' : 'neutral' };
  if (e.failing_since) return { label: `${pct(r)} · failing`, tone: 'danger' };
  if (r >= 95) return { label: pct(r), tone: 'success' };
  if (r >= 80) return { label: pct(r), tone: 'warning' };
  return { label: pct(r), tone: 'danger' };
}

/** Endpoint line under the URL. `danger` when failing. */
export function endpointStatusLine(e: Pick<WebhookEndpoint, 'is_active' | 'disabled_reason' | 'failing_since' | 'last_delivery_at' | 'last_status'>, ago: (iso: string) => string, clock: (iso: string) => string): { text: string; danger: boolean } {
  const status = e.last_status !== null ? ` · ${httpStatusText(e.last_status)}` : '';
  if (!e.is_active) return { text: e.disabled_reason === 'failing' ? 'Turned off after 72 h of failures' : 'Turned off', danger: e.disabled_reason === 'failing' };
  if (e.failing_since) return { text: `Failing since ${clock(e.failing_since)}${status}`, danger: true };
  if (e.last_delivery_at) return { text: `Last delivery ${ago(e.last_delivery_at)}${status}`, danger: false };
  return { text: 'No deliveries yet', danger: false };
}

/** Plan note (144:41323): `locked` = plan lacks api_webhooks (writes disabled), `trial` = trying it free. */
export function planNote(features: FeatureAccess | undefined): { kind: 'locked' } | { kind: 'trial'; until: string } | null {
  if (!features) return null;
  if (!features.features.api_webhooks) return { kind: 'locked' };
  if (features.subscription_status === 'trialing' && features.trial_ends_at) return { kind: 'trial', until: longDate(features.trial_ends_at) };
  return null;
}

/** Stable JSON for the payload viewer. */
export const prettyJson = (v: unknown) => JSON.stringify(v, null, 2);
