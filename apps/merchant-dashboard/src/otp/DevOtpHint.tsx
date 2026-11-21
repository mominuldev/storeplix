import { Button } from '@storeplix/ui';
import { FlaskConical } from 'lucide-react';

/**
 * Local-dev helper (Addendum A, explicitly requested): shows the dummy code only when the API returned
 * `dev_otp` (local + SMS_DRIVER=log) AND this is a Vite dev build. Renders nothing otherwise.
 */
function DevOtpHintImpl({ code, onAutofill, isDev = import.meta.env.DEV }: { code: string | null | undefined; onAutofill: (code: string) => void; isDev?: boolean }) {
  if (!code || !isDev) return null;
  return (
    <div role="note" className="flex items-center gap-2.5 rounded-lg border border-warning/30 bg-warning-bg px-3.5 py-2.5 text-body text-warning">
      <FlaskConical aria-hidden className="size-4 shrink-0" />
      <span className="flex-1">
        Dev mode — your code is <strong className="font-semibold tracking-widest">{code}</strong>
      </span>
      <Button size="sm" variant="ghost" className="text-warning hover:bg-warning/10" onClick={() => onAutofill(code)}>
        Autofill
      </Button>
    </div>
  );
}

type DevOtpHintProps = Parameters<typeof DevOtpHintImpl>[0];

/**
 * Compile-time gate: Vite replaces `import.meta.env.DEV` with `false` in production builds, so the
 * implementation (and its copy) is dead code and dropped from the bundle.
 */
export const DevOtpHint: (props: DevOtpHintProps) => React.ReactNode = import.meta.env.DEV ? DevOtpHintImpl : () => null;
