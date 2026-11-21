import type { StoreSettings, UpdateStoreSettingsInput } from '@storeplix/types';
import { z } from 'zod';
import { businessCategoryCodes } from '../auth/schemas';
import { normalizeBdPhone } from '../lib/phone';

export const settingsKey = (storeId: string | undefined) => ['store-settings', storeId] as const;

// Mirrors the PATCH /stores/{store}/settings FormRequest (Phase 2 contract §1.4).
export const DIVISIONS = ['Barishal', 'Chattogram', 'Dhaka', 'Khulna', 'Mymensingh', 'Rajshahi', 'Rangpur', 'Sylhet'] as const;
export const CURRENCIES = [
  { code: 'BDT', label: '৳ BDT — Bangladeshi Taka' },
  { code: 'USD', label: '$ USD — US Dollar' },
] as const;

const text = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`);
const phone = z
  .string()
  .trim()
  .refine((v) => v === '' || normalizeBdPhone(v) !== null || /^\+[1-9]\d{7,14}$/.test(v), 'Enter a BD mobile (01XXXXXXXXX) or an international number starting with +');

function httpsOnHosts(value: string, hosts: string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
const social = (hosts: string[], example: string) =>
  z
    .string()
    .trim()
    .max(255, 'Use at most 255 characters')
    .refine((v) => v === '' || httpsOnHosts(v, hosts), `Enter a full link like ${example}`);

export const socialHosts = {
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com'],
  instagram: ['instagram.com', 'www.instagram.com'],
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
};

export const settingsSchema = z
  .object({
    identity: z.object({
      name: z.string().trim().min(2, 'Enter your shop name').max(80, 'Use at most 80 characters'),
      name_bn: text(80),
      business_categories: z.array(z.enum(businessCategoryCodes)).max(6, 'Pick up to 6'),
    }),
    branding: z.object({
      logo_media_id: z.string().nullable(),
      favicon_media_id: z.string().nullable(),
      primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #5b53ff'),
      secondary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #fc856d'),
    }),
    contact: z.object({
      phone,
      whatsapp: phone,
      email: z.union([z.literal(''), z.email('Enter a valid email address').max(254)]),
      support_hours: text(80),
    }),
    social: z.object({
      facebook: social(socialHosts.facebook, 'https://facebook.com/yourpage'),
      instagram: social(socialHosts.instagram, 'https://instagram.com/yourshop'),
      youtube: social(socialHosts.youtube, 'https://youtube.com/@yourshop'),
    }),
    address: z.object({
      street: text(255),
      division: z.string(),
      district: text(80),
      area: text(80),
      postcode: z.string().trim(),
      use_for_returns: z.boolean(),
    }),
    region: z.object({
      country: z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code'),
      currency: z.enum(['BDT', 'USD']),
      timezone: z.string().min(1, 'Pick a time zone'),
    }),
  })
  .superRefine((v, ctx) => {
    const bd = v.region.country === 'BD';
    if (v.address.postcode && (bd ? !/^\d{4}$/.test(v.address.postcode) : v.address.postcode.length > 12)) {
      ctx.addIssue({ code: 'custom', path: ['address', 'postcode'], message: bd ? 'Use a 4-digit postcode' : 'Use at most 12 characters' });
    }
    if (bd && v.address.division && !(DIVISIONS as readonly string[]).includes(v.address.division)) {
      ctx.addIssue({ code: 'custom', path: ['address', 'division'], message: 'Pick a division' });
    }
  });

export type SettingsValues = z.infer<typeof settingsSchema>;

export function toFormValues(s: StoreSettings): SettingsValues {
  return {
    identity: { name: s.identity.name, name_bn: s.identity.name_bn ?? '', business_categories: s.identity.business_categories },
    branding: {
      logo_media_id: s.branding.logo?.id ?? null,
      favicon_media_id: s.branding.favicon?.id ?? null,
      primary_color: s.branding.primary_color,
      secondary_color: s.branding.secondary_color,
    },
    contact: { phone: s.contact.phone ?? '', whatsapp: s.contact.whatsapp ?? '', email: s.contact.email ?? '', support_hours: s.contact.support_hours ?? '' },
    social: { facebook: s.social.facebook ?? '', instagram: s.social.instagram ?? '', youtube: s.social.youtube ?? '' },
    address: {
      street: s.address.street ?? '',
      division: s.address.division ?? '',
      district: s.address.district ?? '',
      area: s.address.area ?? '',
      postcode: s.address.postcode ?? '',
      use_for_returns: s.address.use_for_returns,
    },
    region: { country: s.region.country, currency: s.region.currency as 'BDT' | 'USD', timezone: s.region.timezone },
  };
}

type Dirty = Partial<Record<keyof SettingsValues, unknown>>;
const NON_NULLABLE = new Set(['identity.name', 'region.country', 'region.currency', 'region.timezone', 'branding.primary_color', 'branding.secondary_color']);

/** Partial PATCH body: only dirty sections/keys; empty strings become null for nullable fields. */
export function toPatch(values: SettingsValues, dirty: Dirty): UpdateStoreSettingsInput {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const section of Object.keys(dirty) as (keyof SettingsValues)[]) {
    const keys = dirty[section];
    if (!keys || typeof keys !== 'object') continue;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(keys)) {
      const value = (values[section] as Record<string, unknown>)[key];
      out[key] = value === '' && !NON_NULLABLE.has(`${section}.${key}`) ? null : value;
    }
    if (Object.keys(out).length) patch[section] = out;
  }
  return patch as UpdateStoreSettingsInput;
}

export const sectionLabel: Record<keyof SettingsValues, string> = {
  identity: 'Shop identity',
  branding: 'Branding',
  contact: 'Contact',
  social: 'Social links',
  address: 'Business address',
  region: 'Language & region',
};

export function timezones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (list?.length) return list.includes('Asia/Dhaka') ? list : ['Asia/Dhaka', ...list];
  } catch {
    /* older runtimes */
  }
  return ['Asia/Dhaka', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];
}
