import { cn } from '@storeplix/ui';
import { CheckCircle2, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';

// Small app-wide toast (Foundations overlay: ink surface, Elevation/1). Used for "Published. Your shop updates
// in a few seconds." and similar confirmations. Announced politely to screen readers.

interface ToastItem {
  id: number;
  message: string;
  tone: 'success' | 'error';
}

let items: ToastItem[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(message: string, tone: ToastItem['tone'] = 'success', ms = 4000) {
  const id = next++;
  items = [...items, { id, message, tone }];
  emit();
  setTimeout(() => dismiss(id), ms);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
  );
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'pointer-events-auto flex max-w-md items-center gap-2.5 rounded-lg px-4 py-3 text-body shadow-elevation-1',
            t.tone === 'success' ? 'bg-text-primary text-text-inverse' : 'bg-danger text-text-inverse',
          )}
        >
          <CheckCircle2 aria-hidden className="size-4 shrink-0" />
          <span className="flex-1">{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="rounded-sm p-0.5 opacity-70 hover:opacity-100">
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
