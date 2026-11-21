import { Button } from '@storeplix/ui';
import { useState } from 'react';
import { bdMobile, otpCode } from '../auth/schemas';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { formatBdPhone } from '../lib/phone';
import { FormAlert } from '../onboarding/AuthShell';
import { OtpCodeField } from './OtpCodeField';
import { PhoneField } from './PhoneField';
import { formatCountdown, otpErrorMessage, useOtpSender } from './useOtpSender';

// Figma L2 Sign in · SMS code 57:1050: phone → send code → code entry (phone field dimmed) → "Verify and sign in".
// The send response is identical whether or not the phone exists (no enumeration).
export function SmsLoginForm() {
  const { signInWithToken } = useAuth();
  const otp = useOtpSender('login');
  const [rawPhone, setRawPhone] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const parsed = bdMobile.safeParse(rawPhone);
    if (!parsed.success) {
      setPhoneError(parsed.error.issues[0]!.message);
      return;
    }
    setPhoneError(null);
    if (await otp.send(parsed.data)) setPhone(parsed.data);
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone) return;
    if (!otpCode.safeParse(code).success) {
      setCodeError('Enter the 6-digit code');
      return;
    }
    setVerifying(true);
    setCodeError(null);
    try {
      signInWithToken(await api.auth.loginWithOtp({ phone, code }));
    } catch (err) {
      setCodeError(otpErrorMessage(err));
    } finally {
      setVerifying(false);
    }
  };

  if (!phone) {
    return (
      <form onSubmit={sendCode} noValidate className="flex flex-col gap-4">
        {otp.error && <FormAlert>{otp.error}</FormAlert>}
        <PhoneField
          hint="We’ll send a 6-digit code by SMS. We never share your number."
          value={rawPhone}
          onChange={(e) => setRawPhone(e.target.value)}
          error={phoneError ?? undefined}
        />
        <Button type="submit" fullWidth loading={otp.sending} disabled={!otp.canResend && !otp.sending} className="min-h-12">
          {otp.canResend || otp.sending ? 'Send code' : `Send code in ${formatCountdown(otp.countdown)}`}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={verify} noValidate className="flex flex-col gap-4 lg:gap-7">
      <p className="text-body-lg text-text-secondary">We sent a 6-digit code to {formatBdPhone(phone)}.</p>
      <div className="opacity-60">
        <PhoneField value={formatBdPhone(phone)} readOnly tabIndex={-1} aria-readonly />
      </div>
      <OtpCodeField
        value={code}
        onChange={setCode}
        error={codeError ?? otp.error}
        countdown={otp.countdown}
        canResend={otp.canResend}
        onResend={() => void otp.send(phone)}
        devOtp={otp.devOtp}
        autoFocus
        action={
          <button
            type="button"
            className="text-body font-medium text-brand-600 hover:text-brand-700"
            onClick={() => {
              setPhone(null);
              setCode('');
              setCodeError(null);
            }}
          >
            Change number
          </button>
        }
      />
      <Button type="submit" fullWidth loading={verifying} className="min-h-12">
        Verify and sign in
      </Button>
      <p className="text-center text-caption text-text-muted">Codes expire in 5 minutes. Storeplix never asks for your code on a call.</p>
    </form>
  );
}
