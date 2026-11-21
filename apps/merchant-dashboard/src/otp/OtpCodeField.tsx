import { OtpInput } from '@storeplix/ui';
import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { DevOtpHint } from './DevOtpHint';
import { formatCountdown } from './useOtpSender';

interface OtpCodeFieldProps {
  value: string;
  onChange: (code: string) => void;
  error?: string | null;
  countdown: number;
  canResend: boolean;
  onResend: () => void;
  devOtp?: string | null;
  label?: string;
  /** Right side of the label row, e.g. "Change number". */
  action?: ReactNode;
  boxClassName?: string;
  autoFocus?: boolean;
}

// Figma L2 57:1050 code block: "Enter code" + "Change number", 6 boxes (gap 10, h 60), Clock status line.
export function OtpCodeField({ value, onChange, error, countdown, canResend, onResend, devOtp, label = 'Enter code', action, boxClassName, autoFocus }: OtpCodeFieldProps) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-body font-medium text-text-primary">{label}</span>
        {action}
      </div>
      <OtpInput value={value} onChange={onChange} error={!!error} label="Verification code" boxClassName={boxClassName} autoFocus={autoFocus} />
      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
      <p className="flex items-center gap-1.5 text-caption text-text-secondary">
        <Clock aria-hidden className="size-3.5" />
        {canResend ? (
          <>
            Didn’t get it?{' '}
            <button type="button" onClick={onResend} className="font-semibold text-brand-600 hover:text-brand-700">
              Resend code
            </button>
          </>
        ) : (
          <span aria-live="polite">Resend code in {formatCountdown(countdown)}</span>
        )}
      </p>
      <DevOtpHint code={devOtp} onAutofill={onChange} />
    </div>
  );
}
