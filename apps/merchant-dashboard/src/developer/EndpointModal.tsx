import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import { WEBHOOK_EVENT_TYPES, type WebhookEndpoint, type WebhookEventType, type WebhookEventTypeInfo } from '@storeplix/types';
import { Button, Checkbox, Input, Modal } from '@storeplix/ui';
import { AlertTriangle } from 'lucide-react';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage } from '../catalog/states';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { useSaveEndpoint } from './queries';

// PHASE-8-4 §7 "+ Add endpoint" / Edit (no Figma frame: Modal 128:221 + Input 3:58 + Checkbox): URL, events checklist
// with Select all, optional description. The API re-checks the URL (SSRF rules) and answers 422 webhook_url_not_allowed.

const schema = z.object({
  url: z
    .string()
    .trim()
    .min(1, 'Enter the URL that should receive events.')
    .max(2048, 'This URL is too long.')
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    }, 'Enter a full URL starting with https://'),
  events: z.array(z.string()).min(1, 'Pick at least one event.'),
  description: z.string().trim().max(120, 'Use 120 characters or fewer.'),
});
type Values = z.infer<typeof schema>;

export function EndpointModal({ endpoint, eventTypes, onClose }: { endpoint: WebhookEndpoint | null; eventTypes: WebhookEventTypeInfo[] | undefined; onClose: () => void }) {
  const formId = useId();
  const save = useSaveEndpoint();
  const [serverError, setServerError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const catalogue = eventTypes?.length ? eventTypes : WEBHOOK_EVENT_TYPES.map((key) => ({ key, label: key, description: '' }));
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { url: endpoint?.url ?? 'https://', events: endpoint?.events ?? [], description: endpoint?.description ?? '' },
  });

  const submit = handleSubmit(async (v) => {
    setServerError(null);
    setUrlError(null);
    try {
      await save.mutateAsync({ id: endpoint?.id ?? null, input: { url: v.url, events: v.events as WebhookEventType[], description: v.description || null } });
      toast(endpoint ? 'Endpoint saved.' : 'Endpoint added. Send a test event to check it.');
      onClose();
    } catch (e) {
      if (handlePlanLimit(e)) return onClose();
      if (isApiError(e) && e.code === 'webhook_url_not_allowed') setUrlError('This URL can’t receive webhooks. Use a public https:// address (no localhost or private IPs).');
      else if (isApiError(e) && e.code === 'limit_reached') setServerError('A shop can have up to 5 endpoints. Delete one you no longer use first.');
      else if (isApiError(e) && e.code === 'validation_failed' && e.details && 'url' in (e.details as object)) setUrlError(e.message);
      else setServerError(errorMessage(e, 'We couldn’t save the endpoint. Try again.'));
    }
  });

  return (
    <Modal
      open
      size="lg"
      title={endpoint ? 'Edit endpoint' : 'Add endpoint'}
      description="We POST a signed JSON event to this URL. Answer with any 2xx within 10 seconds."
      onClose={save.isPending ? () => undefined : onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            {endpoint ? 'Save' : 'Add endpoint'}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-5">
        <Input
          label="Endpoint URL"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.com/hooks/storeplix"
          error={errors.url?.message ?? urlError ?? undefined}
          {...register('url', { onChange: () => setUrlError(null) })}
        />
        <Controller
          control={control}
          name="events"
          render={({ field }) => {
            const value = new Set(field.value);
            const all = catalogue.every((t) => value.has(t.key));
            return (
              <fieldset className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <legend className="flex-1 text-body font-medium text-text-primary">Events</legend>
                  <Checkbox size="sm" label="Select all" checked={all} onChange={() => field.onChange(all ? [] : catalogue.map((t) => t.key))} />
                </div>
                <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 rounded-lg border border-border-default px-4 py-3 sm:grid-cols-2">
                  {catalogue.map((t) => (
                    <span key={t.key} title={t.description || undefined}>
                      <Checkbox
                        label={<span className="font-mono text-caption text-text-primary">{t.key}</span>}
                        aria-label={t.key}
                        checked={value.has(t.key)}
                        onChange={() => field.onChange(value.has(t.key) ? field.value.filter((k) => k !== t.key) : [...field.value, t.key])}
                      />
                    </span>
                  ))}
                </div>
                {errors.events?.message && <p className="text-caption text-danger">{errors.events.message}</p>}
              </fieldset>
            );
          }}
        />
        <Input label="Description (optional)" maxLength={120} placeholder="e.g. Tally order sync" autoComplete="off" error={errors.description?.message} {...register('description')} />
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
