import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input } from '@storeplix/ui';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { AuthLayout } from '../auth/AuthLayout';
import { useAuth } from '../auth/AuthProvider';
import { applyApiErrors } from '../auth/formErrors';
import { loginSchema, type LoginValues } from '../auth/schemas';

export function LoginPage() {
  const { login } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values);
    } catch (error) {
      setFormError(applyApiErrors(error, setError, ['email', 'password']));
    }
  });

  return (
    <AuthLayout
      headline="Welcome back. Your orders are waiting."
      points={['Confirm and ship orders in one place', 'Book Pathao, Steadfast and RedX in a click', 'Know your real profit every day']}
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-heading-24 text-text-primary">Sign in to your shop</h2>
          <p className="text-body text-text-secondary">
            New here?{' '}
            <Link to="/register" className="font-semibold text-brand-600 hover:text-brand-700">
              Create your free shop
            </Link>
          </p>
        </div>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          {formError && (
            <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
              {formError}
            </p>
          )}
          <Input label="Email" type="email" autoComplete="email" placeholder="you@shop.com" error={errors.email?.message} {...register('email')} />
          <Input
            label="Password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="Your password"
            error={errors.password?.message}
            trailing={
              <button type="button" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? <EyeOff /> : <Eye />}
              </button>
            }
            {...register('password')}
          />
          <div className="flex justify-end">
            <Link to="/forgot-password" className="text-body font-medium text-brand-600 hover:text-brand-700">
              Forgot password?
            </Link>
          </div>
          <Button type="submit" fullWidth loading={isSubmitting} className="mt-2">
            Sign in
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
