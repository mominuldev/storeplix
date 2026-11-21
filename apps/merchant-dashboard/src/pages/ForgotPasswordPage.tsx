import { buttonVariants } from '@storeplix/ui';
import { Link } from 'react-router';
import { AuthLayout } from '../auth/AuthLayout';

// Placeholder: the reset flow ("Locked out? Reset in a minute") needs API endpoints not in the Phase 1 contract.
export function ForgotPasswordPage() {
  return (
    <AuthLayout headline="Locked out? Reset in a minute" points={['We will send a reset code to your email or phone']}>
      <div className="flex flex-col gap-4">
        <h2 className="text-heading-24 text-text-primary">Reset your password</h2>
        <p className="text-body text-text-secondary">Password reset is coming soon. Contact support if you can't sign in.</p>
        <Link to="/login" className={buttonVariants({ variant: 'secondary', fullWidth: true })}>
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
