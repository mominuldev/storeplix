import { isApiError } from '@storeplix/api-client';
import { Button, copyText, CopyField, Dialog, Modal, Skeleton } from '@storeplix/ui';
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, ErrorBlock } from '../catalog/states';
import { dateTime } from '../catalog/format';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { useRevealSecret, useRotateSecret, useWebhookSecret } from './queries';
import { DevCard } from './ui';

// Figma Card / Signing secret 144:41521: masked secret on surface-subtle (radius 8, px 12 py 10) with eye + copy icons,
// ghost "Rotate secret". Eye calls reveal (audited, 10/min); copy reveals first when needed. Rotate confirms the 24 h
// overlap and shows the new secret once. The plain secret is kept in component state only, never in the query cache.

export function SigningSecretCard({ locked }: { locked: boolean }) {
  const secret = useWebhookSecret();
  const reveal = useRevealSecret();
  const [plain, setPlain] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotated, setRotated] = useState<string | null>(null);
  const rotate = useRotateSecret();
  const [now] = useState(() => Date.now());

  const fetchPlain = async (): Promise<string | null> => {
    if (plain) return plain;
    try {
      const r = await reveal.mutateAsync();
      setPlain(r.secret);
      return r.secret;
    } catch (e) {
      if (isApiError(e) && e.status === 429) toast('Too many reveals. Try again in a minute.', 'error');
      else if (!handlePlanLimit(e)) toast(errorMessage(e, 'We couldn’t show the secret. Try again.'), 'error');
      return null;
    }
  };

  const overlapUntil = secret.data?.previous_expires_at && Date.parse(secret.data.previous_expires_at) > now ? secret.data.previous_expires_at : null;

  return (
    <DevCard title="Signing secret" description="Check the X-Storeplix-Signature header with this secret." gap="gap-3">
      {secret.isPending ? (
        <Skeleton className="h-10 w-full rounded-md" />
      ) : secret.isError ? (
        <ErrorBlock title="We couldn’t load the signing secret" error={secret.error} onRetry={() => void secret.refetch()} className="py-6" />
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-md bg-surface-subtle px-3 py-2.5">
            <span data-testid="signing-secret" className="min-w-0 flex-1 truncate font-mono text-body text-text-primary">
              {plain ?? secret.data.masked}
            </span>
            <ReadOnlyActions className="flex items-center gap-1">
              <IconButton
                label={plain ? 'Hide secret' : 'Show secret'}
                disabled={reveal.isPending}
                onClick={() => (plain ? setPlain(null) : void fetchPlain())}
              >
                {plain ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
              </IconButton>
              <IconButton
                label="Copy secret"
                disabled={reveal.isPending}
                onClick={async () => {
                  const value = await fetchPlain();
                  if (value && (await copyText(value))) toast('Secret copied.');
                }}
              >
                <Copy aria-hidden className="size-4" />
              </IconButton>
            </ReadOnlyActions>
          </div>
          {overlapUntil && <p className="text-caption text-text-muted">The previous secret also works until {dateTime(overlapUntil)}.</p>}
          <ReadOnlyActions className="self-start">
            <Button size="sm" variant="ghost" onClick={() => setConfirmRotate(true)} disabled={locked}>
              Rotate secret
            </Button>
          </ReadOnlyActions>
        </>
      )}
      <Dialog
        open={confirmRotate}
        icon={<RefreshCw />}
        iconClassName="bg-warning-bg text-warning"
        title="Rotate the signing secret?"
        description="We start signing with a new secret now. For the next 24 hours each event also carries a signature from the old secret, so you have time to update your app."
        confirmLabel="Rotate secret"
        loading={rotate.isPending}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={() =>
          rotate.mutate(undefined, {
            onSuccess: (r) => {
              setPlain(null);
              setConfirmRotate(false);
              setRotated(r.secret);
            },
            onError: (e) => {
              setConfirmRotate(false);
              if (!handlePlanLimit(e)) toast(errorMessage(e, 'We couldn’t rotate the secret. Try again.'), 'error');
            },
          })
        }
      />
      <Modal
        open={!!rotated}
        size="md"
        title="Your new signing secret"
        description="Copy it into your app now. You can reveal it again later from this page."
        onClose={() => setRotated(null)}
        footer={<Button onClick={() => setRotated(null)}>Done</Button>}
      >
        {rotated && <CopyField label="Signing secret" value={rotated} onCopied={() => toast('Secret copied.')} />}
      </Modal>
    </DevCard>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-text-secondary outline-none hover:bg-surface-card focus-visible:shadow-focus disabled:opacity-40"
    >
      {children}
    </button>
  );
}
