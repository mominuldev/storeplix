import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input } from '@storeplix/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { AuthLayout } from '../auth/AuthLayout';
import { useAuth } from '../auth/AuthProvider';
import { applyApiErrors } from '../auth/formErrors';
import { registerSchema, type RegisterValues } from '../auth/schemas';

export function RegisterPage() {
  const { register: registerAccount } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', phone: '', password: '', password_confirmation: '' },
  });

  const onSubmit = handleSubmit(async ({ phone, ...values }) => {
    setFormError(null);
    try {
      await registerAccount({ ...values, ...(phone ? { phone } : {}) });
    } catch (error) {
      setFormError(applyApiErrors(error, setError, ['name', 'email', 'phone', 'password', 'password_confirmation']));
    }
  });

  return (
    <AuthLayout
      headline="Turn your Facebook page into a real online shop"
      points={['Your own shop at yourname.storeplix.com', 'Cash on delivery, bKash and SSLCommerz', 'Free to start — no card needed']}
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-heading-24 text-text-primary">Create your free shop</h2>
          <p className="text-body text-text-secondary">
            Already selling with us?{' '}
            <Link to="/login" className="font-semibold text-brand-600 hover:text-brand-700">
              Sign in
            </Link>
          </p>
        </div>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          {formError && (
            <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
              {formError}
            </p>
          )}
          <Input label="Full name" autoComplete="name" placeholder="Rahim Ahmed" error={errors.name?.message} {...register('name')} />
          <Input label="Email" type="email" autoComplete="email" placeholder="you@shop.com" error={errors.email?.message} {...register('email')} />
          <Input
            label="Phone (optional)"
            type="tel"
            autoComplete="tel"
            placeholder="01XXXXXXXXX"
            error={errors.phone?.message}
            {...register('phone')}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 8 characters"
            error={errors.password?.message}
            {...register('password')}
          />
          <Input
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            error={errors.password_confirmation?.message}
            {...register('password_confirmation')}
          />
          <Button type="submit" fullWidth loading={isSubmitting} className="mt-2">
            Create my shop
          </Button>
          <p className="text-center text-caption text-text-muted">By continuing you agree to the Terms and Privacy Policy.</p>
        </form>
      </div>
    </AuthLayout>
  );
}
