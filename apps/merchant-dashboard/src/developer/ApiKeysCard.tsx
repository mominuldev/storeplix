import { zodResolver } from '@hookform/resolvers/zod';
import type { ApiKey, ApiScopeInfo } from '@storeplix/types';
import { Badge, Button, cn, Dialog, EmptyState, Input } from '@storeplix/ui';
import { KeyRound, Pencil, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage, ErrorBlock } from '../catalog/states';
import { timeAgo } from '../commerce/format';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { keySubtitle, scopeLabel, scopeTone, visibleScopes } from './developer';
import { useApiKeys, useRenameApiKey, useRevokeApiKey } from './queries';
import { cellClass, DevCard, DevTable, RowMenu, TableSkeleton, TagList } from './ui';

// Figma Card / API keys 144:41332: NAME (name + "Created 2 Oct by Rafiqul" / "Revoked 12 Nov", revoked row muted),
// KEY (masked, mono), ACCESS (scope tags, "Revoked" pill), LAST USED (relative or "—"), row menu (Rename, Revoke).

const columns = [{ label: 'Name' }, { label: 'Key', className: 'w-[166px]' }, { label: 'Access', className: 'w-[226px]' }, { label: 'Last used', className: 'w-[112px]' }, { label: '', className: 'w-11' }];

export function ApiKeysCard({ locked, catalogue, onCreate }: { locked: boolean; catalogue: ApiScopeInfo[] | undefined; onCreate: () => void }) {
  const keys = useApiKeys();
  const [renaming, setRenaming] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  return (
    <DevCard
      title="API keys"
      description="Keys are shown once when created. Store them somewhere safe."
      action={
        <ReadOnlyActions>
          <Button size="sm" variant="secondary" onClick={onCreate} disabled={locked}>
            + New key
          </Button>
        </ReadOnlyActions>
      }
    >
      {keys.isPending ? (
        <TableSkeleton label="Loading API keys" />
      ) : keys.isError ? (
        <ErrorBlock title="We couldn’t load your API keys" error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.data.length === 0 ? (
        <div className="rounded-lg border border-border-default">
          <EmptyState
            icon={<KeyRound />}
            title="No API keys yet"
            description="Create a key to let your accounting, warehouse or Zapier app read and update your shop."
            action={
              !locked && (
                <ReadOnlyActions>
                  <Button size="sm" onClick={onCreate}>
                    Create API key
                  </Button>
                </ReadOnlyActions>
              )
            }
          />
        </div>
      ) : (
        <DevTable label="Key list" columns={columns} minWidth={680}>
          {keys.data.map((k) => {
            const revoked = k.status === 'revoked';
            return (
              <tr key={k.id}>
                <td className={cellClass}>
                  <div className={cn('flex min-w-0 flex-col gap-0.5', revoked && 'text-text-muted')}>
                    <span className={cn('truncate text-body font-medium', !revoked && 'text-text-primary')}>{k.name}</span>
                    <span className={cn('truncate text-caption', !revoked && 'text-text-secondary')}>{keySubtitle(k)}</span>
                  </div>
                </td>
                <td className={cellClass}>
                  <span className="font-mono text-body whitespace-nowrap text-text-secondary">{k.masked}</span>
                </td>
                <td className={cellClass}>
                  {revoked ? (
                    <Badge dot>Revoked</Badge>
                  ) : (
                    <TagList items={visibleScopes(k.scopes).map((s) => {
                      const label = scopeLabel(s, catalogue);
                      return { key: s, label, tone: scopeTone(s, label) };
                    })} />
                  )}
                </td>
                <td className={cn(cellClass, 'text-body whitespace-nowrap text-text-primary')}>{k.last_used_at ? timeAgo(k.last_used_at) : '—'}</td>
                <td className={cellClass}>
                  <ReadOnlyActions>
                    <RowMenu
                      label={`Actions for ${k.name}`}
                      disabled={locked}
                      entries={
                        revoked
                          ? []
                          : [
                              { key: 'rename', label: 'Rename…', icon: <Pencil />, onSelect: () => setRenaming(k) },
                              { key: 'revoke', label: 'Revoke…', icon: <Trash2 />, danger: true, onSelect: () => setRevoking(k) },
                            ]
                      }
                    />
                  </ReadOnlyActions>
                </td>
              </tr>
            );
          })}
        </DevTable>
      )}
      {renaming && <RenameKeyDialog apiKey={renaming} onClose={() => setRenaming(null)} />}
      {revoking && <RevokeKeyDialog apiKey={revoking} onClose={() => setRevoking(null)} />}
    </DevCard>
  );
}

const renameSchema = z.object({ name: z.string().trim().min(1, 'Give the key a name.').max(60, 'Use 60 characters or fewer.') });

function RenameKeyDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const formId = useId();
  const rename = useRenameApiKey();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof renameSchema>>({ resolver: zodResolver(renameSchema), defaultValues: { name: apiKey.name } });
  const submit = handleSubmit(async ({ name }) => {
    setServerError(null);
    try {
      await rename.mutateAsync({ id: apiKey.id, name });
      toast('Key renamed.');
      onClose();
    } catch (e) {
      if (handlePlanLimit(e)) return onClose();
      setServerError(errorMessage(e, 'We couldn’t rename the key. Try again.'));
    }
  });
  return (
    <Dialog open title="Rename key" confirmLabel="Save" formId={formId} loading={rename.isPending} onConfirm={() => undefined} onCancel={onClose}>
      <form id={formId} noValidate onSubmit={submit}>
        <Input label="Name" maxLength={60} autoComplete="off" error={errors.name?.message ?? serverError ?? undefined} {...register('name')} />
      </form>
    </Dialog>
  );
}

function RevokeKeyDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const revoke = useRevokeApiKey();
  return (
    <Dialog
      open
      tone="danger"
      icon={<Trash2 />}
      title={`Revoke “${apiKey.name}”?`}
      description="Apps using this key stop working right away. This can’t be undone — you’d create a new key instead."
      confirmLabel="Revoke key"
      loading={revoke.isPending}
      onCancel={onClose}
      onConfirm={() =>
        revoke.mutate(apiKey.id, {
          onSuccess: () => {
            toast('Key revoked.');
            onClose();
          },
          onError: (e) => {
            if (!handlePlanLimit(e)) toast(errorMessage(e, 'We couldn’t revoke the key. Try again.'), 'error');
          },
        })
      }
    />
  );
}
