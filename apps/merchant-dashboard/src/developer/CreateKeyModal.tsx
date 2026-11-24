import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { ApiKeyCreated, ApiScope, ApiScopeInfo } from '@storeplix/types';
import { Button, Checkbox, CopyField, Input, Modal } from '@storeplix/ui';
import { AlertTriangle, KeyRound } from 'lucide-react';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage, ErrorBlock, LoadingRows } from '../catalog/states';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { groupLabel, groupScopes, impliedBy, notGrantableHint, toggleScope } from './developer';
import { useApiScopes, useCreateApiKey } from './queries';

// PHASE-8-4 §7 "Create key modal" (no Figma frame: composed from Modal 128:221 + Input 3:58 + Checkbox). Step 1: name,
// scope checkboxes grouped per resource (a write ticks and locks its read; non-grantable scopes disabled with a hint),
// "Include cost prices" only for `costs.view`. Step 2: the plain key once, Copy, "I've stored it". The plain key lives
// only in this component's state and is dropped on close.

const schema = z.object({
  name: z.string().trim().min(1, 'Give the key a name.').max(60, 'Use 60 characters or fewer.'),
  scopes: z.array(z.string()).min(1, 'Pick at least one kind of access.'),
  include_costs: z.boolean(),
});
type Values = z.infer<typeof schema>;

export function CreateKeyModal({ open, canViewCosts, onClose }: { open: boolean; canViewCosts: boolean; onClose: () => void }) {
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const close = () => {
    setCreated(null);
    onClose();
  };
  if (!open) return null;
  return created ? <ShowOnce created={created} onDone={close} /> : <KeyForm canViewCosts={canViewCosts} onCancel={close} onCreated={setCreated} />;
}

function KeyForm({ canViewCosts, onCancel, onCreated }: { canViewCosts: boolean; onCancel: () => void; onCreated: (k: ApiKeyCreated) => void }) {
  const formId = useId();
  const scopes = useApiScopes();
  const create = useCreateApiKey();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: '', scopes: [], include_costs: false } });

  const submit = handleSubmit(async (v) => {
    setServerError(null);
    try {
      const key = await create.mutateAsync({ name: v.name, scopes: v.scopes as ApiScope[], ...(canViewCosts ? { include_costs: v.include_costs } : {}) });
      onCreated(key);
    } catch (e) {
      if (handlePlanLimit(e)) return onCancel();
      if (isApiError(e) && e.code === 'scope_not_grantable') setServerError('Your role can’t grant some of this access. Untick it and try again.');
      else if (isApiError(e) && e.code === 'limit_reached') setServerError('You already have 10 active keys. Revoke one you no longer use first.');
      else setServerError(errorMessage(e, 'We couldn’t create the key. Try again.'));
    }
  });

  return (
    <Modal
      open
      size="lg"
      title="Create API key"
      description="Give the key only the access your app needs. You’ll see the key once."
      onClose={create.isPending ? () => undefined : onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending} disabled={!scopes.data}>
            Create key
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-5">
        <Input label="Name" placeholder="e.g. Tally accounting sync" maxLength={60} autoComplete="off" error={errors.name?.message} {...register('name')} />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-body font-medium text-text-primary">Access</legend>
          {scopes.isPending ? (
            <LoadingRows rows={3} label="Loading access options" />
          ) : scopes.isError ? (
            <ErrorBlock title="We couldn’t load access options" error={scopes.error} onRetry={() => void scopes.refetch()} />
          ) : (
            <Controller
              control={control}
              name="scopes"
              render={({ field }) => <ScopePicker catalogue={scopes.data} value={field.value as ApiScope[]} onChange={field.onChange} />}
            />
          )}
          {errors.scopes?.message && <p className="text-caption text-danger">{errors.scopes.message}</p>}
        </fieldset>
        {canViewCosts && (
          <Controller
            control={control}
            name="include_costs"
            render={({ field }) => (
              <div className="flex flex-col gap-1">
                <Checkbox label="Include cost prices" checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
                <p className="pl-[26px] text-caption text-text-muted">Products and stock responses include cost. Leave off for apps that don’t need it.</p>
              </div>
            )}
          />
        )}
        {serverError && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-bg px-3 py-2.5 text-body text-text-primary">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function ScopePicker({ catalogue, value, onChange }: { catalogue: ApiScopeInfo[]; value: ApiScope[]; onChange: (v: ApiScope[]) => void }) {
  const selected = new Set(value);
  const implied = impliedBy(selected, catalogue);
  return (
    <div className="flex flex-col divide-y divide-border-default rounded-lg border border-border-default">
      {groupScopes(catalogue).map(({ group, scopes }) => (
        <div key={group} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
          <span className="text-body font-medium text-text-primary sm:w-28 sm:shrink-0">{groupLabel[group]}</span>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {scopes.map((s) => {
              const locked = implied.has(s.key) && selected.has(s.key);
              const hint = !s.grantable ? notGrantableHint(s) : locked ? 'Included with write access.' : undefined;
              return (
                <span key={s.key} title={hint}>
                  <Checkbox
                    label={s.label}
                    checked={selected.has(s.key)}
                    disabled={!s.grantable || locked}
                    onChange={() => onChange([...toggleScope(selected, s.key, catalogue)])}
                  />
                  {!s.grantable && <span className="sr-only">{hint}</span>}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ShowOnce({ created, onDone }: { created: ApiKeyCreated; onDone: () => void }) {
  return (
    <Modal
      open
      size="md"
      title="Copy your API key"
      description={`“${created.name}” is ready. This is the only time you’ll see the full key.`}
      icon={<KeyRound />}
      iconClassName="bg-brand-50 text-brand-600"
      onClose={onDone}
      footer={<Button onClick={onDone}>I've stored it</Button>}
    >
      <div className="flex flex-col gap-3">
        <CopyField label="API key" value={created.plain_key} onCopied={() => toast('Key copied.')} />
        <p className="flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2.5 text-body text-text-primary">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          Store it in your app’s settings or a password manager. If you lose it, revoke it and create a new one.
        </p>
      </div>
    </Modal>
  );
}
