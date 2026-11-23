import { BUSINESS_CATEGORIES, type BusinessCategory } from '@storeplix/types';
import { z } from 'zod';
import { normalizeBdPhone } from '../lib/phone';

export const loginSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginValues = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: z.email('Enter a valid email address') });
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

/** BD mobile → normalized `8801XXXXXXXXX` (Addendum A). */
export const bdMobile = z
  .string()
  .trim()
  .min(1, 'Enter your mobile number')
  .refine((v) => normalizeBdPhone(v) !== null, 'Enter a Bangladeshi mobile number, e.g. 01712-345678')
  .transform((v) => normalizeBdPhone(v)!);

/** Contract §1.1 password rule: 8–128 chars with letters and numbers. */
export const newPassword = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');

const confirmed = <T extends { password: string; password_confirmation: string }>(v: T) => v.password === v.password_confirmation;
const mismatch = { path: ['password_confirmation'], message: 'Passwords do not match' };

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name'),
    email: z.email('Enter a valid email address'),
    phone: bdMobile,
    password: newPassword,
    password_confirmation: z.string(),
  })
  .refine(confirmed, mismatch);
export type RegisterValues = z.infer<typeof registerSchema>;
export type RegisterFormInput = z.input<typeof registerSchema>;

export const resetPasswordSchema = z.object({ password: newPassword, password_confirmation: z.string() }).refine(confirmed, mismatch);
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

export const otpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const changePasswordSchema = z
  .object({ current_password: z.string().min(1, 'Enter your current password'), password: newPassword, password_confirmation: z.string() })
  .refine(confirmed, mismatch);
export type ChangePasswordValues = z.infer<typeof changePasswordSchema>;

export const acceptInviteSchema = z
  .object({ name: z.string().trim().min(2, 'Enter your full name'), phone: bdMobile, password: newPassword, password_confirmation: z.string() })
  .refine(confirmed, mismatch);
export type AcceptInviteValues = z.infer<typeof acceptInviteSchema>;
export type AcceptInviteInput = z.input<typeof acceptInviteSchema>;

export const inviteSchema = z.object({
  name: z.string().trim().max(120),
  email: z.email('Enter a valid email address'),
  /** PHASE-8-3 §7.4: the invite sends `role_id` (system or custom role). */
  role_id: z.string().min(1, 'Choose a role'),
});
export type InviteValues = z.infer<typeof inviteSchema>;

export const businessCategoryCodes = BUSINESS_CATEGORIES.map((c) => c.code) as [BusinessCategory, ...BusinessCategory[]];

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export const nameShopSchema = z.object({
  name: z.string().trim().min(2, 'Enter your shop name').max(80, 'Keep it under 80 characters'),
  slug: z
    .string()
    .trim()
    .min(3, 'Use at least 3 characters')
    .max(40, 'Use at most 40 characters')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes'),
  categories: z.array(z.enum(businessCategoryCodes)).max(6),
});
export type NameShopValues = z.infer<typeof nameShopSchema>;
