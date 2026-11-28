import { describe, expect, it } from 'vitest';
import { initialConfigureState, stepErrors, toCreateInput } from './configure';
import {
  countBroadcast,
  countTemplate,
  defaultLogFilters,
  dhakaToIso,
  isHttpsUrl,
  nameMatches,
  normalizeBdPhone,
  parseSmsSettingsTab,
  parseTypedCount,
  providerInitials,
  scheduleProblem,
  skippedLine,
  templateProblem,
  toLogQuery,
  topAlert,
  withinSendingHours,
} from './format';
import { reveDriver } from './fixtures';
import { smsParts } from './smsParts';

describe('PHASE-8-9B helpers', () => {
  it('parses the tab param (unknown → provider)', () => {
    expect(parseSmsSettingsTab('log')).toBe('log');
    expect(parseSmsSettingsTab('messages')).toBe('messages');
    expect(parseSmsSettingsTab('nope')).toBe('provider');
    expect(parseSmsSettingsTab(null)).toBe('provider');
  });

  it('normalises Bangladesh mobiles to 8801…', () => {
    expect(normalizeBdPhone('01711-555211')).toBe('8801711555211');
    expect(normalizeBdPhone('+880 1711 555211')).toBe('8801711555211');
    expect(normalizeBdPhone('০১৭১১৫৫৫২১১')).toBe('8801711555211');
    expect(normalizeBdPhone('01211555211')).toBeNull();
    expect(normalizeBdPhone('abc')).toBeNull();
  });

  it('checks https, typed names and typed counts', () => {
    expect(isHttpsUrl('https://smpp.revesms.com/api')).toBe(true);
    expect(isHttpsUrl('http://smpp.revesms.com')).toBe(false);
    expect(isHttpsUrl('nonsense')).toBe(false);
    expect(nameMatches('  reve sms ', 'REVE SMS')).toBe(true);
    expect(nameMatches('REVE', 'REVE SMS')).toBe(false);
    expect(nameMatches('', '')).toBe(false);
    expect(parseTypedCount('1,177')).toBe(1177);
    expect(parseTypedCount('১১৭৭')).toBe(1177);
    expect(parseTypedCount('11a')).toBeNull();
    expect(providerInitials('REVE SMS')).toBe('RS');
    expect(providerInitials('alpha')).toBe('AL');
  });

  it('enforces the 9 AM – 9 PM Dhaka window at the boundaries', () => {
    expect(withinSendingHours(new Date('2026-11-30T02:59:00Z'))).toBe(false); // 08:59 Dhaka
    expect(withinSendingHours(new Date('2026-11-30T03:00:00Z'))).toBe(true); // 09:00
    expect(withinSendingHours(new Date('2026-11-30T14:59:00Z'))).toBe(true); // 20:59
    expect(withinSendingHours(new Date('2026-11-30T15:00:00Z'))).toBe(false); // 21:00
    const now = new Date('2026-11-28T04:00:00Z'); // 10:00 Dhaka
    expect(dhakaToIso('2026-11-30', '10:00')).toBe('2026-11-30T04:00:00.000Z');
    expect(scheduleProblem('2026-11-30', '08:59', now)).toBe('outside_hours');
    expect(scheduleProblem('2026-11-30', '09:00', now)).toBeNull();
    expect(scheduleProblem('2026-11-30', '20:59', now)).toBeNull();
    expect(scheduleProblem('2026-11-30', '21:00', now)).toBe('outside_hours');
    expect(scheduleProblem('2026-11-28', '10:02', now)).toBe('too_soon');
    expect(scheduleProblem('2027-01-10', '10:00', now)).toBe('too_far');
    expect(scheduleProblem('', '10:00', now)).toBe('invalid');
  });

  it('counts parts like the server (GSM-7 vs UCS-2) and includes the STOP footer for broadcasts', () => {
    expect(smsParts('a'.repeat(160)).parts).toBe(1);
    expect(smsParts('a'.repeat(161)).parts).toBe(2);
    expect(smsParts('আ'.repeat(70)).parts).toBe(1);
    expect(smsParts('আ'.repeat(71)).parts).toBe(2);
    const plain = countTemplate('Hi {merchant_name}', 'en');
    const withFooter = countBroadcast('Hi {merchant_name}', 'en');
    expect(withFooter.characters).toBeGreaterThan(plain.characters + 'STOP: '.length);
    expect(countBroadcast('অফার', 'bn').encoding).toBe('ucs2');
  });

  it('flags template problems in the server’s order', () => {
    const allowed = ['merchant_name', 'invoice_no', 'link'];
    const c = (b: string) => countTemplate(b, 'en');
    expect(templateProblem('', allowed, [], c(''))).toEqual({ code: 'empty' });
    expect(templateProblem('Hi {otp}', allowed, [], c('Hi {otp}'))).toEqual({ code: 'unknown', fields: ['otp'] });
    expect(templateProblem('Hi {merchant_name}', allowed, ['invoice_no'], c('Hi'))).toEqual({ code: 'missing', fields: ['invoice_no'] });
    expect(templateProblem('Pay at https://x.y {invoice_no}', allowed, ['invoice_no'], c('x'))).toEqual({ code: 'link' });
    const long = 'x'.repeat(455) + ' {invoice_no}';
    expect(templateProblem(long, allowed, ['invoice_no'], c(long))).toMatchObject({ code: 'too_long' });
  });

  it('picks the most severe alert and summarises skipped recipients', () => {
    expect(topAlert([])).toBeNull();
    expect(
      topAlert([
        { code: 'promotional_paused', severity: 'info', message: 'a', provider_id: null },
        { code: 'no_provider', severity: 'danger', message: 'b', provider_id: null },
        { code: 'low_balance', severity: 'warning', message: 'c', provider_id: null },
      ])?.code,
    ).toBe('no_provider');
    expect(skippedLine({ opted_out: 96, no_verified_phone: 11, weekly_cap: 0, suspended: 0, duplicate: 0 })).toBe('96 opted out · 11 no verified phone');
  });

  it('maps log filters (30-day default, "all" dropped)', () => {
    const now = new Date('2026-11-28T06:00:00Z');
    const d = defaultLogFilters(now);
    expect(d).toMatchObject({ from: '2026-10-29', to: '2026-11-28', status: 'all', group: 'all' });
    expect(toLogQuery({ ...d, q: ' 01711555211 ', status: 'failed', group: 'billing' }, 'C1')).toEqual({
      q: '01711555211',
      status: ['failed'],
      group: ['billing'],
      from: '2026-10-29',
      to: '2026-11-28',
      cursor: 'C1',
    });
    expect(toLogQuery(d).status).toBeUndefined();
  });

  it('validates the configure steps and builds the create body', () => {
    const s = initialConfigureState('primary');
    expect(stepErrors(1, s, undefined).driver).toBe('Pick a provider.');
    expect(stepErrors(1, { ...s, driver: 'ssl_wireless' }, { ...reveDriver, code: 'ssl_wireless', name: 'SSL Wireless', status: 'coming_soon' }).driver).toMatch(/coming soon/);
    const filled = { ...s, driver: 'revesms' as const, name: 'REVE SMS', credentials: { api_key: 'k123', secret_key: 's456' }, baseUrl: 'http://smpp.revesms.com' };
    expect(stepErrors(2, filled, reveDriver).base_url).toBe('Use an https:// address.');
    expect(stepErrors(2, { ...filled, baseUrl: 'https://smpp.revesms.com' }, reveDriver)).toEqual({});
    expect(stepErrors(3, { ...filled, groups: ['shop', 'billing'] }, reveDriver).groups).toMatch(/primary must send/);
    expect(stepErrors(3, { ...filled, role: 'failover', groups: ['billing'] }, reveDriver)).toEqual({});
    const body = toCreateInput({ ...filled, baseUrl: 'https://smpp.revesms.com', promoSender: 'SPXOffers', accountId: 'STPX-2041' }, reveDriver);
    expect(body).toMatchObject({
      driver: 'revesms',
      name: 'REVE SMS',
      credentials: { api_key: 'k123', secret_key: 's456' },
      settings: { account_id: 'STPX-2041', base_url: 'https://smpp.revesms.com', http: null },
      promotional_sender_id: 'SPXOffers',
      promotional_sender_status: 'pending',
      message_groups: ['shop', 'registration', 'billing', 'security', 'promotional'],
      rate_limit_per_minute: 300,
      price_masking_paisa: 40,
    });
  });
});
