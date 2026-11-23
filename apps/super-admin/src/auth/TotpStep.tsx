import { zodResolver } from '@hookform/resolvers/zod';
import type { AdminSession } from '@storeplix/types';
import { Button, Input, OtpInput } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { ChevronLeft, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api } from '../lib/api';
import { FormAlert, ShieldTile } from './AuthLayout';
import { recoveryCodeSchema } from './schemas';
import { classifyTotpError, MAX_TOTP_ATTEMPTS, type TotpFailure } from './totpErrors';

// Figma 2FA 44:4784: "Back to sign in", shield tile, "Two-factor verification", 6 code boxes, "Verify and sign in",
// "or" divider, then the recovery-code option (instead of "Use a security key", Q93), warning box
// "N incorrect code(s) · M attempts left". No "Trust this device" (Q93).
export function TotpStep({
  loginToken,
  email,
  onSignedIn,
  onExit,
}: {
  loginToken: string;
  email: string;
  onSignedIn: (s: AdminSession) => void;
  onExit: (reason: 'back' | 'locked' | 'expired') => void;
}) {
  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [failure, setFailure] = useState<TotpFailure | null>(null);
  const recovery = useForm<{ recovery_code: string }>({
    resolver: zodResolver(recoveryCodeSchema),
    defaultValues: { recovery_code: '' },
  });

  const mutation = useMutation({
    mutationFn: (input: { code: string } | { recovery_code: string }) => api.admin.auth.totp({ login_token: loginToken, ...input }),
    onSuccess: onSignedIn,
    onError: (error) => {
      const f = classifyTotpError(error);
      if (f.kind === 'locked' || f.kind === 'expired') return onExit(f.kind);
      setFailure(f);
      setCode('');
    },
  });

  const submitCode = () => {
    if (!/^\d{6}$/.test(code)) {
      setCodeError('Enter the 6-digit code');
      return;
    }
    setCodeError(null);
    mutation.mutate({ code });
  };

  const failed = failure?.kind === 'wrong' ? MAX_TOTP_ATTEMPTS - failure.attemptsLeft : 0;

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
        <h1 className="text-heading-32 text-text-primary">Two-factor verification</h1>
        <p className="text-body text-text-secondary">
          {mode === 'code' ? 'Enter the 6-digit code from your authenticator app for ' : 'Enter one of your saved recovery codes for '}
          <strong className="font-semibold text-text-primary">{email}</strong>.
        </p>
      </div>

      {mode === 'code' ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submitCode();
          }}
          className="flex flex-col gap-6"
        >
          <div className="flex flex-col gap-2">
            <OtpInput value={code} onChange={setCode} label="Authentication code" autoFocus error={!!codeError} disabled={mutation.isPending} />
            {codeError && <p className="text-caption text-danger">{codeError}</p>}
          </div>
          <Button type="submit" fullWidth loading={mutation.isPending} className="min-h-11">
            Verify and sign in
          </Button>
        </form>
      ) : (
        <form noValidate onSubmit={recovery.handleSubmit(({ recovery_code }) => mutation.mutate({ recovery_code }))} className="flex flex-col gap-6">
          <Input
            label="Recovery code"
            autoComplete="one-time-code"
            autoFocus
            spellCheck={false}
            error={recovery.formState.errors.recovery_code?.message}
            {...recovery.register('recovery_code')}
          />
          <Button type="submit" fullWidth loading={mutation.isPending} className="min-h-11">
            Verify and sign in
          </Button>
        </form>
      )}

      <div className="flex items-center gap-3 text-caption text-text-muted" aria-hidden>
        <span className="h-px flex-1 bg-border-default" />
        or
        <span className="h-px flex-1 bg-border-default" />
      </div>
      <Button
        variant="secondary"
        fullWidth
        className="min-h-11"
        onClick={() => {
          setMode((m) => (m === 'code' ? 'recovery' : 'code'));
          setFailure(null);
          setCodeError(null);
        }}
      >
        <KeyRound aria-hidden className="size-4" />
        {mode === 'code' ? 'Use a recovery code' : 'Use your authenticator app'}
      </Button>

      {failure?.kind === 'wrong' && (
        <FormAlert
          tone="warning"
          title={`${failed} incorrect code${failed === 1 ? '' : 's'} · ${failure.attemptsLeft} attempt${failure.attemptsLeft === 1 ? '' : 's'} left`}
        >
          After 5 failed attempts this account is locked for 15 minutes and the security team is alerted.
        </FormAlert>
      )}
      {failure?.kind === 'message' && <FormAlert>{failure.message}</FormAlert>}
    </div>
  );
}
