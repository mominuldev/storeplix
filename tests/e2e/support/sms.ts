import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';
import { apiCall, LARAVEL_LOG, mailMark, tinker, type ApiResult, type Session } from './api';
import { mUrl } from './locations';
import { retryLocked, spath } from './purchasing';

/**
 * Phase 8.9a helpers (PHASE-8-9A-CONTRACT §5–§10, §12, §13, §15 QA): SMS overview, test SMS, templates, sender IDs, the
 * SMS log, credits (purchase through the Phase 7 fake billing gateway, `BILLING_FAKE=true`) and the super-admin review.
 * Real API, no mocks. Local SMS driver = `log` (SMS_DRIVER=log): every SMS the shop sends is a `sms.log_driver` line in
 * laravel.log with `to`, `text`, `sender_id`.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const SMS_PAGE = '/integrations/sms';
export type SmsTab = 'overview' | 'templates' | 'sender-id' | 'log' | 'credits';

const call = (as: Session, method: string, path: string, json?: unknown, headers?: Record<string, string>) =>
  retryLocked(() => apiCall(as, method, path, { ...(json === undefined ? {} : { json }), ...(headers ? { headers } : {}) }));

export async function ok(r: ApiResult, status: number, what: string): Promise<Json> {
  expect(r.status, `${what}: ${r.text.slice(0, 500)}`).toBe(status);
  return r.json.data as Json;
}

const sp = (s: Session, rest = '') => spath(s, `/sms${rest}`);

// ----- Merchant API (§10.1) -----
export const overviewRaw = (s: Session, as: Session = s) => call(as, 'GET', sp(s));
export const overview = async (s: Session) => ok(await overviewRaw(s), 200, 'sms overview');
export const testSmsRaw = (s: Session, language: 'bn' | 'en' | null = null, as: Session = s) => call(as, 'POST', sp(s, '/test'), { language });
export const templatesRaw = (s: Session, as: Session = s) => call(as, 'GET', sp(s, '/templates'));
export async function template(s: Session, key: string, language: 'bn' | 'en'): Promise<Json> {
  const list = (await ok(await templatesRaw(s), 200, 'templates')) as unknown as Json[];
  const t = list.find((x) => x.key === key && x.language === language);
  expect(t, `template ${key}.${language}`).toBeTruthy();
  return t!;
}
export const putTemplateRaw = (s: Session, key: string, language: 'bn' | 'en', body: string, revision: number | null, as: Session = s) =>
  call(as, 'PUT', sp(s, `/templates/${key}/${language}`), { body, revision });
export const resetTemplateRaw = (s: Session, key: string, language: 'bn' | 'en', as: Session = s) => call(as, 'DELETE', sp(s, `/templates/${key}/${language}`));
export const senderIdsRaw = (s: Session, as: Session = s) => call(as, 'GET', sp(s, '/sender-ids'));
export const cancelSenderIdRaw = (s: Session, id: string, as: Session = s) => call(as, 'POST', sp(s, `/sender-ids/${id}/cancel`), {});
export const messagesRaw = (s: Session, query = '', as: Session = s) => call(as, 'GET', sp(s, `/messages${query ? `?${query}` : ''}`));
export async function messages(s: Session, query = ''): Promise<Json[]> {
  return (await ok(await messagesRaw(s, query), 200, 'sms log')) as unknown as Json[];
}

/** Multipart sender-ID request (`integrations.manage`) with a tiny valid PDF. */
export function requestSenderIdRaw(s: Session, senderId: string, o: { business?: string; uses?: string[]; as?: Session; pdf?: Buffer } = {}): Promise<ApiResult> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    sender_id: senderId,
    business_name: o.business ?? 'QA Trading House',
    'uses[]': (o.uses ?? ['order_updates'])[0]!,
    rights_confirmed: '1',
    document: { name: 'trade-licence.pdf', mimeType: 'application/pdf', buffer: o.pdf ?? tinyPdf() },
  };
  return retryLocked(() => apiCall(o.as ?? s, 'POST', sp(s, '/sender-ids'), { multipart }));
}

// ----- Credits (tenant-level, §5) -----
export const creditsRaw = (s: Session, as: Session = s) => call(as, 'GET', '/billing/sms-credits');
export const credits = async (s: Session) => ok(await creditsRaw(s), 200, 'sms credits');
export const ledgerRaw = (s: Session, query = '', as: Session = s) => call(as, 'GET', `/billing/sms-credits/ledger${query ? `?${query}` : ''}`);
export const purchaseRaw = (s: Session, pack: string, provider = 'bkash', as: Session = s, key: string | null = randomUUID()) =>
  call(as, 'POST', '/billing/sms-credits/purchase', { pack, provider }, key ? { 'Idempotency-Key': key } : undefined);

// ----- Fixtures (test-only DB writes through tinker; ids validated before interpolation) -----
const ULID = /^[0-9a-z]{26}$/i;
const guard = (...ids: string[]) => ids.forEach((id) => { if (!ULID.test(id)) throw new Error(`bad id ${id}`); });

/** Marks the shop owner's phone verified (the test SMS goes only to a verified phone, P89A-2). Returns the phone. */
export function verifyOwnerPhone(s: Session, ownerEmail: string): string {
  guard(s.tenantId);
  if (!/^[a-z0-9.+-]+@e2e\.storeplix\.test$/.test(ownerEmail)) throw new Error('bad email');
  const out = tinker(
    `$u=App\\Domain\\Identity\\Models\\User::where('email','${ownerEmail}')->firstOrFail(); DB::table('users')->where('id',$u->id)->update(['phone_verified_at'=>now()]); echo 'PHONE:'.$u->phone;`,
  );
  return out.match(/PHONE:(\S+)/)?.[1] ?? '';
}

/** Seeds `count` allowance-paid transactional SMS this month without a store (never listed; they only use the allowance). */
export function seedAllowanceUsage(s: Session, count: number): void {
  guard(s.tenantId);
  tinker(
    [
      `$t='${s.tenantId}'; $rows=[];`,
      `for($i=0;$i<${Math.floor(count)};$i++){ $rows[]=['id'=>strtolower((string) Illuminate\\Support\\Str::ulid()),'tenant_id'=>$t,'to'=>'8801700000000','purpose'=>'order_placed','template'=>'order_placed.bn','status'=>'sent','charged_from'=>'allowance','created_at'=>now(),'updated_at'=>now()]; }`,
      `foreach(array_chunk($rows,100) as $c){ DB::table('sms_messages')->insert($c); }`,
      `App\\Domain\\Billing\\FeatureGate::forget($t); Illuminate\\Support\\Facades\\Cache::flush(); echo 'ok';`,
    ].join(' '),
  );
}

/** Seeds one SMS log row for the store (status/purpose as given), e.g. a failed or skipped row for the log filters. */
export function seedLogRow(s: Session, o: { purpose: string; status: 'sent' | 'failed' | 'skipped' | 'queued'; to: string; preview: string; charged?: 'allowance' | 'credits' | null; daysAgo?: number }): void {
  guard(s.tenantId, s.storeId);
  if (!/^8801\d{9}$/.test(o.to) || /['\\]/.test(o.preview) || !/^[a-z_]+$/.test(o.purpose)) throw new Error('bad seed');
  const ch = o.charged === undefined ? 'null' : o.charged === null ? 'null' : `'${o.charged}'`;
  tinker(
    `$at=now()->subDays(${Math.floor(o.daysAgo ?? 0)}); DB::table('sms_messages')->insert(['id'=>strtolower((string) Illuminate\\Support\\Str::ulid()),'tenant_id'=>'${s.tenantId}','store_id'=>'${s.storeId}','to'=>'${o.to}','purpose'=>'${o.purpose}','template'=>'${o.purpose}.en','status'=>'${o.status}','charged_from'=>${ch},'parts'=>1,'body_preview'=>'${o.preview}','created_at'=>$at,'updated_at'=>$at]); echo 'ok';`,
  );
}

/**
 * Cleanup for a throwaway SMS shop. `sms_credit_ledger (tenant_id, billing_invoice_id) → billing_invoices` and
 * `sms_sender_ids (tenant_id, document_media_id) → media` are ON DELETE RESTRICT, so the tenant cascade can fail once
 * the shop bought credits or uploaded a licence. Test-only: remove those child rows of THIS e2e tenant first (refused
 * unless its only owner is an @e2e.storeplix.test address), then the usual tenant cleanup.
 */
export function cleanupSmsShop(shop: { s: Session; t: { email: string }; cleanup: () => void } | undefined): void {
  if (!shop) return;
  guard(shop.s.tenantId);
  if (!/^[a-z0-9.+-]+@e2e\.storeplix\.test$/.test(shop.t.email)) throw new Error('refusing');
  tinker(
    [
      `$t='${shop.s.tenantId}'; $e='${shop.t.email}';`,
      `$owners=DB::table('tenant_users')->join('users','users.id','=','tenant_users.user_id')->where('tenant_users.tenant_id',$t)->where('tenant_users.role','owner')->pluck('users.email')->all();`,
      `if($owners===[$e]){ DB::table('sms_credit_ledger')->where('tenant_id',$t)->delete(); DB::table('sms_sender_ids')->where('tenant_id',$t)->delete(); echo 'ok'; }`,
    ].join(' '),
  );
  shop.cleanup();
}

/** Random valid sender ID (3–11 alnum with a letter), globally unique enough for local runs. */
export const randomSenderId = () => `QA${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 4).toUpperCase()}${Math.floor(Math.random() * 90 + 10)}`;

/** A minimal, valid one-page PDF (sniffed as application/pdf). */
export function tinyPdf(): Buffer {
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(body.length);
    body += o;
  }
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// ----- The log driver (SMS_DRIVER=log) -----
export const smsMark = mailMark;

export interface SentSms {
  to: string;
  text: string;
  sender_id: string | null;
}

/** `sms.log_driver` lines written after `mark` (decoded JSON context). */
export function sentSince(mark: number): SentSms[] {
  if (!existsSync(LARAVEL_LOG)) return [];
  const buf = readFileSync(LARAVEL_LOG);
  const out: SentSms[] = [];
  for (const line of buf.subarray(Math.min(mark, buf.length)).toString('utf8').split('\n')) {
    const i = line.indexOf('sms.log_driver ');
    if (i < 0) continue;
    try {
      const ctx = JSON.parse(line.slice(i + 'sms.log_driver '.length)) as SentSms;
      out.push(ctx);
    } catch {
      /* not a JSON context line */
    }
  }
  return out;
}

/** Waits until an SMS to `msisdn` matching `pred` was sent after `mark` (the queue worker sends order SMS). */
export async function waitSms(mark: number, pred: (m: SentSms) => boolean, what: string, timeout = 45_000): Promise<SentSms> {
  let hit: SentSms | undefined;
  await expect.poll(() => (hit = sentSince(mark).find(pred)) !== undefined, { timeout, intervals: [500, 1_000, 2_000], message: `${what} (queue worker running? SMS_DRIVER=log?)` }).toBe(true);
  return hit!;
}

/** `017…` → `88017…`. */
export const msisdn = (phone: string) => (phone.startsWith('880') ? phone : `88${phone.replace(/^\+?88/, '')}`);

// ----- UI (§12) -----
export async function openSms(page: Page, tab: SmsTab = 'overview', extra = ''): Promise<void> {
  const q = tab === 'overview' ? extra.replace(/^&/, '?') : `?tab=${tab}${extra}`;
  await page.goto(mUrl(`${SMS_PAGE}${q}`));
  await expect(page.getByRole('heading', { name: 'SMS', level: 1 })).toBeVisible({ timeout: 20_000 });
}

export const smsTabs = (page: Page): Locator => page.getByRole('tablist', { name: 'SMS sections' });
export const panel = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });
export const templateRow = (page: Page, label: string): Locator => page.getByRole('list', { name: 'SMS templates' }).getByRole('listitem', { name: label, exact: true });
export const editor = (page: Page): Locator => page.getByRole('region', { name: /^(Edit template|Template)$/ }).or(page.getByRole('dialog', { name: /^(Edit template|Template)$/ })).first();
export const toastText = (page: Page, text: string | RegExp): Locator => page.getByText(text).first();
