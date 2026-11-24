import { z } from 'zod';
import { CHECKOUT_OTP_LENGTH, type CheckoutOtpResponse, type FraudCheckoutErrorCode } from '@storeplix/types';

/**
 * Phase 8.8a fake-order guard at checkout (PHASE-8-8 §7, §10.4, P88-9/P88-11/P88-13). Pure and client-safe: copy,
 * the `/storefront/checkout/otp` boundary schema and small helpers shared by the checkout form and its Server Actions.
 *
 * Copy is `{ en, bn }` like the 8.6 contact notice; the storefront has no store-language setting yet, so the theme
 * shows `en` (the Bangla line is ready for when it does).
 */

export type Localized = { readonly en: string; readonly bn: string };

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnDigits = (s: string) => s.replace(/\d/g, (d) => BN_DIGITS[Number(d)]!);

export const GUARD_COPY = {
  otpLabel: { en: 'Verification code', bn: 'যাচাই কোড' },
  otpHelp: (phone: string): Localized => ({
    en: `We sent a 6-digit code to ${phone}.`,
    bn: `${phone} নম্বরে আমরা একটি ৬ সংখ্যার কোড পাঠিয়েছি।`,
  }),
  otpSending: { en: 'Sending a code…', bn: 'কোড পাঠানো হচ্ছে…' },
  resend: { en: 'Resend code', bn: 'আবার কোড পাঠান' },
  resendIn: (seconds: number): Localized => ({
    en: `Resend in ${formatCountdown(seconds)}`,
    bn: `${bnDigits(formatCountdown(seconds))} পরে আবার পাঠান`,
  }),
  otpRequired: { en: 'Enter the code we sent.', bn: 'আমাদের পাঠানো কোডটি লিখুন।' },
  otpInvalid: (left: number | null): Localized =>
    left === null
      ? { en: "That code isn't right.", bn: 'কোডটি সঠিক নয়।' }
      : left <= 0
        ? { en: "That code isn't right. Send a new code.", bn: 'কোডটি সঠিক নয়। নতুন কোড পাঠান।' }
        : {
            en: `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
            bn: `কোডটি সঠিক নয়। আর ${bnDigits(String(left))} বার চেষ্টা করতে পারবেন।`,
          },
  otpTooMany: {
    en: 'Too many codes asked for this number. Wait a few minutes and try again.',
    bn: 'এই নম্বরে অনেকবার কোড চাওয়া হয়েছে। কয়েক মিনিট পরে আবার চেষ্টা করুন।',
  },
  codUnavailable: {
    en: "Cash on delivery isn't available for this number. Please pay online.",
    bn: 'এই নম্বরে ক্যাশ অন ডেলিভারি পাওয়া যাচ্ছে না। অনুগ্রহ করে অনলাইনে পেমেন্ট করুন।',
  },
  orderLimitReached: {
    en: "You've reached today's order limit for cash on delivery. Please pay online or try tomorrow.",
    bn: 'ক্যাশ অন ডেলিভারিতে আজকের অর্ডারের সীমা পূর্ণ হয়েছে। অনুগ্রহ করে অনলাইনে পেমেন্ট করুন বা আগামীকাল চেষ্টা করুন।',
  },
  /** P88-16 / Q189 (accepted wording): fixed line under the checkout COD note. */
  privacy: {
    en: "To prevent fake orders, we check your phone number's delivery record with this shop.",
    bn: 'ভুয়া অর্ডার ঠেকাতে আমরা এই দোকানে আপনার ফোন নম্বরের ডেলিভারি রেকর্ড যাচাই করি।',
  },
} as const;

/** `42` → `0:42`, `75` → `1:15`. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const OTP_LENGTH = CHECKOUT_OTP_LENGTH;
export const OTP_CODE_RE = new RegExp(`^\\d{${CHECKOUT_OTP_LENGTH}}$`);

/** What the code input keeps: digits only (Bangla digits typed on a BN keyboard become ASCII), at most 6. */
export function cleanOtpInput(raw: string): string {
  return raw
    .replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)))
    .replace(/\D/g, '')
    .slice(0, OTP_LENGTH);
}

/** `otp_invalid` details → tries left (`details.attempts_left`, a number or `["3"]` on the wire), else null. */
export function attemptsLeft(details: Record<string, string[]>): number | null {
  const raw = details.attempts_left?.[0];
  if (raw === undefined || !/^\d{1,2}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** `POST /storefront/checkout/otp` → 200 `{required, expires_at|null, resend_after_seconds}` (§7). */
export const CheckoutOtpSchema: z.ZodType<CheckoutOtpResponse, unknown> = z.object({
  required: z.boolean(),
  expires_at: z.string().max(64).nullable().catch(null),
  resend_after_seconds: z.number().int().min(0).max(3600).catch(60),
});

export type CheckoutOtp = CheckoutOtpResponse;

export function parseCheckoutOtp(data: unknown): CheckoutOtp | null {
  const r = CheckoutOtpSchema.safeParse(data);
  return r.success ? r.data : null;
}

/** Checkout 422 codes owned by the guard (§7). */
export type GuardErrorCode = FraudCheckoutErrorCode;
export const GUARD_ERROR_CODES: ReadonlySet<string> = new Set<GuardErrorCode>(['otp_required', 'otp_invalid', 'cod_unavailable', 'order_limit_reached']);
