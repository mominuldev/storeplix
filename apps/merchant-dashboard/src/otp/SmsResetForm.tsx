import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import { Button, Input } from '@storeplix/ui';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { bdMobile, otpCode, resetPasswordSchema, type ResetPasswordValues } from '../auth/schemas';
import { api } from '../lib/api';
import { formatBdPhone } from '../lib/phone';
import { FormAlert, FormTitle } from '../onboarding/AuthShell';
import { OtpCodeField } from './OtpCodeField';
import { PhoneField } from './PhoneField';
import { formatCountdown, otpErrorMessage, useOtpSender } from './useOtpSender';

// Figma L3 Forgot password 57:1198 (SMS flow): phone → code + new password → "Save password and sign in".
export function SmsResetForm() {
  const otp = useOtpSender('reset_password');
  const [rawPhone, setRawPhone] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({ resolver: zodResolver(resetPasswordSchema), defaultValues: { password: '', password_confirmation: '' } });

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = bdMobile.safeParse(rawPhone);
    if (!parsed.success) return setPhoneError(parsed.error.issues[0]!.message);
    setPhoneError(null);
    if (await otp.send(parsed.data)) setPhone(parsed.data);
  };

  const onSubmit = handleSubmit(async (values) => {
    if (!phone) return;
    if (!otpCode.safeParse(code).success) return setCodeError('Enter the 6-digit code');
    setCodeError(null);
    try {
      await api.auth.resetPasswordWithOtp({ phone, code, ...values });
      setDone(true);
    } catch (err) {
      if (isApiError(err) && err.isValidation && (err.fieldError('password') || err.fieldError('password_confirmation'))) {
        if (err.fieldError('password')) setError('password', { message: err.fieldError('password') });
        if (err.fieldError('password_confirmation')) setError('password_confirmation', { message: err.fieldError('password_confirmation') });
      } else setCodeError(otpErrorMessage(err));
    }
  });

  if (done) {
    return (
      <div role="status" className="flex flex-col gap-4">
        <CheckCircle2 aria-hidden className="size-10 text-success" />
        <FormTitle title="Password updated" subtitle="Your new password is saved and other devices were signed out." />
        <Link to="/login" className="text-body font-semibold text-brand-600 hover:text-brand-700">
          Sign in with your new password
        </Link>
      </div>
    );
  }

  if (!phone) {
    return (
      <form onSubmit={sendCode} noValidate className="flex flex-col gap-4 lg:gap-7">
        <FormTitle title="Reset with an SMS code" subtitle="Enter the mobile number on your account. We’ll text you a 6-digit code." />
        {otp.error && <FormAlert>{otp.error}</FormAlert>}
        <PhoneField value={rawPhone} onChange={(e) => setRawPhone(e.target.value)} error={phoneError ?? undefined} />
        <Button type="submit" fullWidth loading={otp.sending} disabled={!otp.canResend && !otp.sending} className="min-h-12">
          {otp.canResend || otp.sending ? 'Send code' : `Send code in ${formatCountdown(otp.countdown)}`}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 lg:gap-7">
      <FormTitle title="Set a new password" subtitle={`We sent a code to ${formatBdPhone(phone)}. Enter it and choose a new password.`} />
      <OtpCodeField
        label="Code from SMS"
        value={code}
        onChange={setCode}
        error={codeError ?? otp.error}
        countdown={otp.countdown}
        canResend={otp.canResend}
        onResend={() => void otp.send(phone)}
        devOtp={otp.devOtp}
        autoFocus
        action={
          <button type="button" className="text-body font-medium text-brand-600" onClick={() => setPhone(null)}>
            Change number
          </button>
        }
      />
      <div className="flex flex-col gap-3">
        <Input label="New password" type="password" autoComplete="new-password" hint="8+ characters · a letter · a number" error={errors.password?.message} {...register('password')} />
        <Input label="Confirm new password" type="password" autoComplete="new-password" error={errors.password_confirmation?.message} {...register('password_confirmation')} />
      </div>
      <Button type="submit" fullWidth loading={isSubmitting} className="min-h-12">
        Save password and sign in
      </Button>
      <p className="text-center text-caption text-text-muted">For your safety, other devices will be signed out.</p>
    </form>
  );
}
