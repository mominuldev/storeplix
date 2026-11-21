import { isApiError } from '@storeplix/api-client';
import type { OtpPurpose } from '@storeplix/types';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Sends OTP codes and tracks the resend cooldown (`resend_in`, or `retry_after` on 429 otp_rate_limited). */
export function useOtpSender(purpose: OtpPurpose) {
  const [countdown, setCountdown] = useState(0);
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  const send = useCallback(
    async (phone: string): Promise<boolean> => {
      setSending(true);
      setError(null);
      try {
        const res = await api.auth.sendOtp({ phone, purpose });
        setCountdown(res?.resend_in ?? 60);
        setDevOtp(res?.dev_otp ?? null);
        return true;
      } catch (e) {
        if (isApiError(e) && e.status === 429) {
          const wait = e.retryAfter ?? 60;
          setCountdown(wait);
          setError(`Too many codes requested. Try again in ${formatCountdown(wait)}.`);
        } else if (isApiError(e)) {
          setError(e.fieldError('phone') ?? e.message);
        } else {
          setError('Could not send the code. Please try again.');
        }
        return false;
      } finally {
        setSending(false);
      }
    },
    [purpose],
  );

  return { send, sending, countdown, canResend: countdown <= 0 && !sending, devOtp, error, setError };
}

/** Maps verify/login errors on the code to a friendly message. */
export function otpErrorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.code === 'invalid_otp' || e.fieldError('code')) return e.fieldError('code') ?? 'That code is wrong or has expired. Check the SMS or resend.';
    if (e.status === 429) return `Too many attempts. Try again in ${formatCountdown(e.retryAfter ?? 60)}.`;
    return e.message;
  }
  return 'Something went wrong. Please try again.';
}
