import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { API_DIR, api, urls, type Session } from './api';
import { rawFetch } from './commerce';

/**
 * Phase 6 helpers (PHASE-6-CONTRACT §4, §4.4, §10 QA). Everything runs on the fake drivers (`DOMAINS_FAKE=true`):
 * fake DNS answers and the fake Cloudflare for SaaS state are written through the testing-only
 * `POST /api/v1/dev/domains/{domain}/{dns|provider|age}` routes (404 unless DOMAINS_FAKE=true) and live in the API's
 * cache store. Never call a helper that flushes the cache (`browserHost`, `setPlan`, `mapStoreHost`) after a fake
 * DNS answer was written, or the fake forgets it.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type DnsAnswer = { ownership: 'correct' | 'wrong' | 'missing'; routing: 'correct' | 'wrong' | 'missing' | 'flattened' };
export type ProviderState = { hostname_status: 'pending' | 'active' | 'blocked' | 'moved'; ssl_status: 'pending' | 'active' | 'failed' };

const dev = async (id: string, what: 'dns' | 'provider' | 'age', body: Json, check: boolean) => {
  const r = await rawFetch(`${urls.api}/api/v1/dev/domains/${id}/${what}${check ? '?check=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  expect(r.status, `dev ${what} ${JSON.stringify(body)} → ${r.text.slice(0, 300)}`).toBe(200);
  return r.json.data as Json;
};

/** Sets the fake DNS answers for the domain's TXT + routing records (optionally runs a check right away). */
export const devDns = (id: string, a: DnsAnswer, check = false) => dev(id, 'dns', a, check);
/** Sets the fake Cloudflare custom-hostname state (the next check reads it). */
export const devProvider = (id: string, p: ProviderState, check = false) => dev(id, 'provider', p, check);
/** Moves verification_started_at / status_changed_at / first_failed_at back by `hours` (1..400). */
export const devAge = (id: string, hours: number, check = false) => dev(id, 'age', { hours }, check);

export async function listDomains(s: Session): Promise<{ data: Json[]; meta: Json }> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/domains`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { data: r.json.data as Json[], meta: r.json.meta as Json };
}

export async function domainByHost(s: Session, host: string): Promise<Json> {
  const d = (await listDomains(s)).data.find((x) => x.hostname === host);
  expect(d, `domain ${host} in the list`).toBeTruthy();
  return d!;
}

export const getDomain = async (s: Session, id: string) => (await api(s, 'GET', `/stores/${s.storeId}/domains/${id}`)).json.data as Json;

export async function waitDomainStatus(s: Session, id: string, status: string | RegExp, timeout = 30_000): Promise<Json> {
  await expect
    .poll(async () => (await getDomain(s, id))?.status as string, { timeout, message: `domain ${id} → ${status}` })
    .toMatch(typeof status === 'string' ? new RegExp(`^${status}$`) : status);
  return getDomain(s, id);
}

/** `DOMAINS_ASK_KEY` from the env, else apps/api/.env, else the compose dev default. */
export function askKey(): string {
  if (process.env.DOMAINS_ASK_KEY) return process.env.DOMAINS_ASK_KEY;
  const env = resolve(API_DIR, '.env');
  const m = existsSync(env) ? readFileSync(env, 'utf8').match(/^DOMAINS_ASK_KEY=(.*)$/m) : null;
  return (m?.[1] ?? 'dev-domains-ask-key-change-me').trim().replace(/^"|"$/g, '');
}

/** The internal Caddy `ask` endpoint (P6-17). `key: null` sends none. */
export function ask(domain: string, key: string | null = askKey()) {
  const q = new URLSearchParams({ domain, ...(key === null ? {} : { key }) });
  return rawFetch(`${urls.api}/api/v1/internal/domains/allowed?${q}`, { headers: { Accept: 'application/json' } });
}

/**
 * Raw GET to the storefront origin (STOREFRONT_URL's port) with an explicit Host header, no redirect following.
 * Lets the spec request the real platform host `{slug}.storeplix.test` without a hosts entry or resolver rule.
 */
export function storefrontGet(host: string, path: string, method = 'GET'): Promise<{ status: number; location: string | null; body: string; headers: Record<string, string | string[] | undefined> }> {
  const sf = new URL(urls.storefront);
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: Number(sf.port || 80), path, method, headers: { Host: `${host}${sf.port ? `:${sf.port}` : ''}`, Accept: 'text/html' } },
      (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (body += c));
        r.on('end', () => res({ status: r.statusCode ?? 0, location: (r.headers.location as string | undefined) ?? null, body, headers: r.headers }));
      },
    );
    req.on('error', rej);
    req.setTimeout(30_000, () => req.destroy(new Error(`storefront ${host}${path} timed out`)));
    req.end();
  });
}

export const canonicalHref = (html: string): string | null => html.match(/<link[^>]+rel="canonical"[^>]*href="([^"]+)"/)?.[1] ?? html.match(/<link[^>]+href="([^"]+)"[^>]*rel="canonical"/)?.[1] ?? null;

// ---------------------------------------------------------------------------------------------
// Dashboard UI (WEB 6.3, PHASE-6-CONTRACT §8). Every selector lives in one helper so a copy change is one edit.
// ---------------------------------------------------------------------------------------------
export async function openDomains(page: Page): Promise<void> {
  await page.goto(`${urls.merchant}/online-store/domains`);
  await expect(page.getByRole('heading', { name: /^Domains$/ }).first()).toBeVisible({ timeout: 20_000 });
}

/** The card/row of one domain (display hostname is its accessible name or visible text). */
export function domainCard(page: Page, host: string): Locator {
  const byName = page.getByRole('article', { name: host });
  const byText = page.locator('article, li, [role="listitem"], [data-testid="domain-card"]').filter({ hasText: host });
  return byName.or(byText).first();
}

export const connectButton = (page: Page) => page.getByRole('button', { name: /^Connect (a|your) domain$/ }).first();

/** Connect dialog → hostname → Connect. Returns the dialog (still open on an error). */
export async function submitConnect(page: Page, hostname: string): Promise<Locator> {
  await connectButton(page).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').first().fill(hostname);
  await dialog.getByRole('button', { name: /^(Connect|Add domain|Continue|Next)$/ }).last().click();
  return dialog;
}

/** Runs an action from the card's actions menu (Make primary, Check now, View DNS records, Remove), or a direct button. */
export async function cardAction(page: Page, host: string, action: 'Make primary' | 'Check now' | 'View DNS records' | 'Remove'): Promise<void> {
  const card = domainCard(page, host);
  const direct = card.getByRole('button', { name: action, exact: true });
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }
  await card.getByRole('button', { name: /^Manage|actions|more|options/i }).first().click();
  await page.getByRole('menuitem', { name: action }).click();
}

export const statusBadge = (page: Page, host: string, label: string) => domainCard(page, host).getByText(label, { exact: true }).first();

export async function noHorizontalOverflow(page: Page, name: string, outputPath: (n: string) => string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const { scroll, client, culprits } = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const culprits = [...document.querySelectorAll('body *')]
      .filter((e) => !(e instanceof SVGElement) && e.getBoundingClientRect().right > w + 0.5 && getComputedStyle(e).position !== 'fixed')
      .slice(0, 6)
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 80)} "${(e.textContent ?? '').trim().slice(0, 40)}" right=${Math.round(e.getBoundingClientRect().right)}`);
    return { scroll: document.documentElement.scrollWidth, client: w, culprits };
  });
  if (scroll > client) console.log(`[${name}] overflow:`, culprits.join(' | '));
  await page.screenshot({ path: outputPath(`${name}-390.png`), fullPage: true });
  expect(scroll, `${name}: scrollWidth ${scroll} > clientWidth ${client}`).toBeLessThanOrEqual(client);
}
