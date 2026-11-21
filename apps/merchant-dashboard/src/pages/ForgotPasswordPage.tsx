import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input, SegmentedControl } from '@storeplix/ui';
import { CheckCircle2, ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { applyApiErrors } from '../auth/formErrors';
import { forgotPasswordSchema, type ForgotPasswordValues } from '../auth/schemas';
import { api } from '../lib/api';
import { AuthShell, FormAlert, FormTitle } from '../onboarding/AuthShell';
import { SmsResetForm } from '../otp/SmsResetForm';

const BANGLA = 'পাসওয়ার্ড ভুলে গেছেন? এক মিনিটেই নতুন করে নিন।';

// Figma Merchant Onboarding · L3 Forgot password 57:1198. Two ways: SMS code → new password (Addendum A,
// the Figma flow) or an email reset link (POST /auth/forgot-password, always 202, no enumeration).
export function ForgotPasswordPage() {
  const [method, setMethod] = useState<'sms' | 'email'>('sms');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({ resolver: zodResolver(forgotPasswordSchema), defaultValues: { email: '' } });

  const onSubmit = handleSubmit(async ({ email }) => {
    setFormError(null);
    try {
      await api.auth.forgotPassword({ email });
      setSentTo(email);
    } catch (error) {
      setFormError(applyApiErrors(error, setError, ['email']));
    }
  });

  const signIn = (
    <Link to="/register" className="text-body font-semibold text-brand-600 hover:text-brand-700">
      Create your shop
    </Link>
  );

  return (
    <AuthShell
      pitch={{ eyebrow: 'Your shop, orders and money — in one place', headline: 'Locked out? Back in a minute.', bangla: BANGLA }}
      topLeft="Welcome back"
      topRight={<>New to Storeplix? {signIn}</>}
      mobile={{ variant: 'hero', title: 'Reset your password', bangla: BANGLA }}
    >
      <div className="flex flex-col gap-4 lg:gap-7">
        <Link to="/login" className="flex items-center gap-1.5 self-start text-body font-medium text-brand-600 hover:text-brand-700">
          <ChevronLeft aria-hidden className="size-4" /> Back to sign in
        </Link>
        <SegmentedControl
          aria-label="Reset method"
          value={method}
          onChange={setMethod}
          options={[
            { value: 'sms', label: 'SMS code' },
            { value: 'email', label: 'Email link' },
          ]}
        />
        {method === 'sms' ? (
          <SmsResetForm />
        ) : sentTo ? (
          <div role="status" className="flex flex-col gap-4">
            <CheckCircle2 aria-hidden className="size-10 text-success" />
            <FormTitle
              title="Check your email"
              subtitle={`If an account exists for ${sentTo}, we’ve sent instructions to reset your password.`}
            />
            <p className="text-caption text-text-muted">Didn’t get it? Check spam, or try again in a few minutes.</p>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 lg:gap-7">
            <FormTitle title="Reset your password" subtitle="Enter the email you signed up with and we’ll send you a reset link." />
            {formError && <FormAlert>{formError}</FormAlert>}
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              placeholder="you@shop.com"
              fieldClassName="min-h-12"
              error={errors.email?.message}
              {...register('email')}
            />
            <Button type="submit" fullWidth loading={isSubmitting} className="min-h-12">
              Send reset link
            </Button>
            <p className="text-center text-caption text-text-muted">For your safety, other devices will be signed out.</p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
