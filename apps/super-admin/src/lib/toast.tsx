import { cn } from '@storeplix/ui';
import { CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';

type Tone = 'success' | 'danger';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

let seq = 0;

/** Short confirmation after an admin action ("Invoice email sent"). Polite live region, auto-dismiss after 5 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (message: string, tone: Tone = 'success') => {
      const id = ++seq;
      setToasts((all) => [...all.slice(-2), { id, tone, message }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100%-32px))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-surface-card px-4 py-3 text-body shadow-elevation-1',
              t.tone === 'danger' ? 'border-danger text-danger' : 'border-border-default text-text-primary',
            )}
          >
            {t.tone === 'danger' ? (
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            ) : (
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            )}
            <span className="min-w-0 flex-1">{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="rounded-sm text-text-muted hover:text-text-primary">
              <X aria-hidden className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

export function useToast() {
  const ctx = use(ToastContext);
  // Outside the provider (isolated component tests) toasts are a no-op.
  return ctx ?? (() => undefined);
}
