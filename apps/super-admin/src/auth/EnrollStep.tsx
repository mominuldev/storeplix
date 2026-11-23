import type { AdminSession } from '@storeplix/types';
import { Button, CopyValue, OtpInput, Skeleton } from '@storeplix/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { toBase64 } from '../lib/download';
import { errorMessage } from '../lib/errors';
import { FormAlert, ShieldTile } from './AuthLayout';
import { classifyTotpError, MAX_TOTP_ATTEMPTS } from './totpErrors';

/** Groups the base32 secret in fours for reading aloud / typing. */
const groupSecret = (s: string) =>
  s
    .replace(/\s+/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim();

// Composed from 2FA 44:4784 (P8-4): the QR (server SVG, shown as an <img> data URL — never injected as markup), the
// manual key, then a 6-digit confirmation code. Success answers the session + 10 recovery codes (shown next).
export function EnrollStep({
  loginToken,
  email,
  onEnrolled,
  onExit,
}: {
  loginToken: string;
  email: string;
  onEnrolled: (s: AdminSession, recoveryCodes: string[]) => void;
  onExit: (reason: 'back' | 'locked' | 'expired') => void;
}) {
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const enrollment = useQuery({
    queryKey: ['admin-enrollment', loginToken],
    queryFn: () => api.admin.auth.enrollment(loginToken),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const confirm = useMutation({
    mutationFn: () => api.admin.auth.confirmEnrollment(loginToken, code),
    onSuccess: (res) => onEnrolled(res.session, res.recovery_codes),
    onError: (error) => {
      const f = classifyTotpError(error);
      if (f.kind === 'locked' || f.kind === 'expired') return onExit(f.kind);
      setCode('');
      setFailure(
        f.kind === 'wrong'
          ? `That code didn’t match. ${f.attemptsLeft} of ${MAX_TOTP_ATTEMPTS} attempts left. Check the time on your phone and try the newest code.`
          : f.message,
      );
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={() => onExit('back')}
        className="-ml-1 flex items-center gap-1 self-start rounded-md px-1 text-body font-medium text-text-secondary outline-none hover:text-text-primary focus-visible:shadow-focus"
      >
        <ChevronLeft aria-hidden className="size-4" />
        Back to sign in
      </button>
      <ShieldTile />
      <div className="flex flex-col gap-1.5">
        <h1 className="text-heading-32 text-text-primary">Set up two-factor verification</h1>
        <p className="text-body text-text-secondary">
          Every staff account needs an authenticator app. Scan the code with Google Authenticator, 1Password or Authy for{' '}
          <strong className="font-semibold text-text-primary">{email}</strong>.
        </p>
      </div>

      {enrollment.isPending ? (
        <div role="status" aria-label="Loading the setup code" className="flex items-center gap-4">
          <Skeleton className="size-40 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ) : enrollment.isError ? (
        <FormAlert title="We couldn’t load the setup code">
          {classifyTotpError(enrollment.error).kind === 'expired' ? 'This sign-in timed out. Go back and sign in again.' : errorMessage(enrollment.error)}
        </FormAlert>
      ) : (
        <div className="flex flex-col gap-4 rounded-lg border border-border-default p-4 sm:flex-row sm:items-center">
          <img
            src={`data:image/svg+xml;base64,${toBase64(enrollment.data.qr_svg)}`}
            alt="QR code for your authenticator app"
            width={160}
            height={160}
            className="size-40 shrink-0 self-center rounded-md bg-surface-card"
          />
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-body font-medium text-text-primary">Can’t scan? Enter this key</p>
            <CopyValue value={groupSecret(enrollment.data.secret)} label="Copy setup key" />
            <p className="text-caption text-text-muted">Time-based (TOTP), 6 digits, 30 seconds.</p>
          </div>
        </div>
      )}

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^\d{6}$/.test(code)) {
            setCodeError('Enter the 6-digit code');
            return;
          }
          setCodeError(null);
          setFailure(null);
          confirm.mutate();
        }}
        className="flex flex-col gap-6"
      >
        <div className="flex flex-col gap-2">
          <p className="text-body font-medium text-text-primary">Enter the code your app shows</p>
          <OtpInput value={code} onChange={setCode} label="Authentication code" error={!!codeError} disabled={!enrollment.isSuccess || confirm.isPending} />
          {codeError && <p className="text-caption text-danger">{codeError}</p>}
        </div>
        <Button type="submit" fullWidth loading={confirm.isPending} disabled={!enrollment.isSuccess} className="min-h-11">
          Turn on 2FA and continue
        </Button>
      </form>
      {failure && <FormAlert>{failure}</FormAlert>}
    </div>
  );
}
