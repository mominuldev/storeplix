import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input, ProgressBar } from '@storeplix/ui';
import { Check, Eye, EyeOff, Star } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { applyApiErrors } from '../auth/formErrors';
import { registerSchema, type RegisterFormInput, type RegisterValues } from '../auth/schemas';
import { images } from '../onboarding/assets';
import { AuthShell, FormAlert, FormTitle } from '../onboarding/AuthShell';
import { TrustTiles } from '../onboarding/TrustRow';

const BANGLA = '৫ মিনিটে আপনার অনলাইন দোকান চালু করুন — কোনো কোডিং লাগবে না।';
const perks = ['Free plan', 'No card needed'];

// Figma Merchant Onboarding · 01 Sign up 46:8583 (desktop) / M1 53:758 (mobile).
// Figma collects mobile + name and verifies by SMS (02, later phase). The Phase 1 register contract
// needs email + password, so those fields are added below the Figma fields; no OTP is faked.
export function RegisterPage() {
  const { register: registerAccount } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormInput, unknown, RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', phone: '', password: '', password_confirmation: '' },
  });

  const onSubmit = handleSubmit(async ({ phone, ...values }) => {
    setFormError(null);
    try {
      await registerAccount({ ...values, phone: `+88${phone}` });
    } catch (error) {
      setFormError(applyApiErrors(error, setError, ['name', 'email', 'phone', 'password', 'password_confirmation']));
    }
  });

  const loginLink = (
    <Link to="/login" className="text-body font-semibold text-brand-600 hover:text-brand-700">
      Log in
    </Link>
  );
  const eye = (
    <button type="button" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
      {showPassword ? <EyeOff /> : <Eye />}
    </button>
  );

  return (
    <AuthShell
      pitch={{ eyebrow: 'Built for Facebook & COD sellers in Bangladesh', headline: 'Turn your Facebook page into a real online shop.', bangla: BANGLA }}
      topLeft={
        <>
          Step 1 of 7 · Create account
          <ProgressBar value={1 / 7} label="Setup progress" className="w-[120px]" />
        </>
      }
      topRight={<>Already selling with Storeplix? {loginLink}</>}
      mobile={{ variant: 'plain', action: loginLink }}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5 lg:gap-7">
        <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-brand-50 px-2.5 py-[5px] text-caption font-medium text-brand-700 lg:hidden">
          <Star aria-hidden className="size-3.5 text-brand-600" /> Free for Facebook &amp; COD sellers
        </span>
        <FormTitle
          className="hidden lg:flex"
          title="Create your free shop"
          subtitle="Start with your mobile number — you’ll use your email and password to sign in."
        />
        <div className="flex flex-col gap-1.5 lg:hidden">
          <h2 className="text-heading-24 text-text-primary">Create your free shop</h2>
          <p className="text-body text-text-secondary">Start with your mobile number and name.</p>
          <p lang="bn" className="font-bangla text-body-lg leading-[26px] text-text-muted">
            ৫ মিনিটে আপনার অনলাইন দোকান চালু করুন
          </p>
        </div>
        {formError && <FormAlert>{formError}</FormAlert>}
        <div className="flex flex-col gap-4">
          <Input
            label="Mobile number"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="01712-345678"
            fieldClassName="min-h-12 max-lg:min-h-[52px] max-lg:rounded-control"
            className="text-body-lg"
            leading={
              <>
                <img src={images.flagBd} alt="" width={20} height={14} className="hidden lg:block" />
                +88
              </>
            }
            hint="We’ll use it for order updates. We never share your number."
            error={errors.phone?.message}
            {...register('phone')}
          />
          <Input label="Your name" autoComplete="name" placeholder="Rahim Uddin" error={errors.name?.message} {...register('name')} />
          <Input label="Email" type="email" autoComplete="email" placeholder="you@shop.com" error={errors.email?.message} {...register('email')} />
          <Input
            label="Password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            hint="At least 8 characters"
            trailing={eye}
            error={errors.password?.message}
            {...register('password')}
          />
          <Input
            label="Confirm password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            error={errors.password_confirmation?.message}
            {...register('password_confirmation')}
          />
        </div>
        <Button type="submit" fullWidth loading={isSubmitting}>
          Continue
        </Button>
        <ul className="flex flex-wrap gap-2 lg:justify-center">
          {perks.map((p) => (
            <li key={p} className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1.5 text-caption font-medium text-success">
              <Check aria-hidden className="size-3.5" /> {p}
            </li>
          ))}
          <li lang="bn" className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1.5 font-bangla text-caption font-medium text-success">
            <Check aria-hidden className="size-3.5" /> বাংলা সাপোর্ট
          </li>
        </ul>
        <TrustTiles />
        <p className="text-center text-caption text-text-muted">
          By continuing you agree to Storeplix’s Terms of Service and Privacy Policy.
        </p>
      </form>
    </AuthShell>
  );
}
