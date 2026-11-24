import type { WebhookDelivery, WebhookDeliveryEventType, WebhookDeliveryStatus, WebhookEndpoint, WebhookEventTypeInfo } from '@storeplix/types';
import { WEBHOOK_EVENT_TYPES } from '@storeplix/types';
import { Badge, Button, Drawer, Select } from '@storeplix/ui';
import { ArrowLeft, Send } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { dateTime } from '../catalog/format';
import { errorMessage, ErrorBlock, LoadingRows } from '../catalog/states';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { deliveryErrorLabel, deliveryPill, deliveryStatusLabel, httpStatusText, prettyJson } from './developer';
import { useDeliveryDetail, useDeliveryLog, useResendDelivery } from './queries';

// PHASE-8-4 §7 deliveries log (no Figma frame: Drawer 128:221 + Select 39:4614 + the Recent-deliveries row). Filters
// (endpoint, status, event), cursor pages of 25 ("Load more"), detail with payload / request headers / response and
// Resend (a new delivery with the same payload).

const STATUSES: WebhookDeliveryStatus[] = ['succeeded', 'failed', 'retrying', 'pending'];

export function DeliveriesDrawer({
  open,
  initialId,
  endpoints,
  eventTypes,
  locked,
  onClose,
}: {
  open: boolean;
  initialId: string | null;
  endpoints: WebhookEndpoint[] | undefined;
  eventTypes: WebhookEventTypeInfo[] | undefined;
  locked: boolean;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(initialId);
  const [endpointId, setEndpointId] = useState('');
  const [status, setStatus] = useState<WebhookDeliveryStatus | ''>('');
  const [eventType, setEventType] = useState<WebhookDeliveryEventType | ''>('');
  const filters = { endpoint_id: endpointId || undefined, status: status || undefined, event_type: eventType || undefined };
  const log = useDeliveryLog(filters, open && !selected);
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];
  const endpointUrl = (id: string) => endpoints?.find((e) => e.id === id)?.url;
  const events: WebhookDeliveryEventType[] = [...(eventTypes?.map((t) => t.key) ?? WEBHOOK_EVENT_TYPES), 'ping'];

  return (
    <Drawer open={open} onClose={onClose} title={selected ? 'Delivery' : 'Delivery log'} description={selected ? undefined : 'Kept for 30 days.'} width={640}>
      {selected ? (
        <DeliveryDetail id={selected} endpointUrl={endpointUrl} locked={locked} onBack={() => setSelected(null)} onOpen={setSelected} />
      ) : (
        <div className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select aria-label="Endpoint" value={endpointId} onChange={(e) => setEndpointId(e.target.value)}>
              <option value="">All endpoints</option>
              {endpoints?.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.url}
                </option>
              ))}
            </Select>
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as WebhookDeliveryStatus | '')}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {deliveryStatusLabel[s]}
                </option>
              ))}
            </Select>
            <Select aria-label="Event" value={eventType} onChange={(e) => setEventType(e.target.value as WebhookDeliveryEventType | '')}>
              <option value="">All events</option>
              {events.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>
          {log.isPending ? (
            <LoadingRows rows={6} label="Loading deliveries" />
          ) : log.isError ? (
            <ErrorBlock title="We couldn’t load deliveries" error={log.error} onRetry={() => void log.refetch()} />
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-body text-text-muted">{endpointId || status || eventType ? 'No deliveries match these filters.' : 'No deliveries yet.'}</p>
          ) : (
            <ul aria-label="Deliveries" className="flex flex-col divide-y divide-border-default rounded-lg border border-border-default">
              {rows.map((d) => (
                <DeliveryRow key={d.id} delivery={d} endpointUrl={endpointUrl(d.endpoint_id)} onOpen={() => setSelected(d.id)} />
              ))}
            </ul>
          )}
          {log.hasNextPage && (
            <Button variant="secondary" size="sm" className="self-center" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
              Load more
            </Button>
          )}
        </div>
      )}
    </Drawer>
  );
}

function DeliveryRow({ delivery: d, endpointUrl, onOpen }: { delivery: WebhookDelivery; endpointUrl: string | undefined; onOpen: () => void }) {
  const pill = deliveryPill(d);
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-surface-subtle focus-visible:shadow-focus">
        <Badge tone={pill.tone} dot>
          {pill.label}
        </Badge>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body text-text-primary">
            {d.event_type}
            {d.subject_label ? ` · ${d.subject_label}` : ''}
          </span>
          <span className="truncate text-caption text-text-muted">{endpointUrl ?? 'Deleted endpoint'}</span>
        </span>
        <span className="shrink-0 text-caption whitespace-nowrap text-text-muted">{dateTime(d.created_at)}</span>
      </button>
    </li>
  );
}

function DeliveryDetail({ id, endpointUrl, locked, onBack, onOpen }: { id: string; endpointUrl: (id: string) => string | undefined; locked: boolean; onBack: () => void; onOpen: (id: string) => void }) {
  const detail = useDeliveryDetail(id);
  const resend = useResendDelivery();
  const d = detail.data;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" leftIcon={<ArrowLeft aria-hidden className="size-4" />} onClick={onBack}>
          All deliveries
        </Button>
        <span className="flex-1" />
        {d && (
          <ReadOnlyActions>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Send aria-hidden className="size-4" />}
              loading={resend.isPending}
              disabled={locked}
              onClick={() =>
                resend.mutate(d.id, {
                  onSuccess: (r) => {
                    toast('Delivery queued again.');
                    onOpen(r.id);
                  },
                  onError: (e) => {
                    if (!handlePlanLimit(e)) toast(errorMessage(e, 'We couldn’t resend. Try again.'), 'error');
                  },
                })
              }
            >
              Resend
            </Button>
          </ReadOnlyActions>
        )}
      </div>
      {detail.isPending ? (
        <LoadingRows rows={4} label="Loading delivery" />
      ) : detail.isError ? (
        <ErrorBlock title="We couldn’t load this delivery" error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        d && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={deliveryPill(d).tone} dot>
                {deliveryStatusLabel[d.status]}
              </Badge>
              <span className="text-body font-medium text-text-primary">
                {d.event_type}
                {d.subject_label ? ` · ${d.subject_label}` : ''}
              </span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body">
              <Meta label="Endpoint">
                <span className="break-all">{endpointUrl(d.endpoint_id) ?? 'Deleted endpoint'}</span>
              </Meta>
              <Meta label="Created">{dateTime(d.created_at)}</Meta>
              <Meta label="Attempts">{d.attempts}</Meta>
              {d.last_attempt_at && <Meta label="Last attempt">{dateTime(d.last_attempt_at)}</Meta>}
              {d.next_attempt_at && <Meta label="Next attempt">{dateTime(d.next_attempt_at)}</Meta>}
              <Meta label="Response">
                {d.response_status !== null ? httpStatusText(d.response_status) : d.error_code ? deliveryErrorLabel[d.error_code] : '—'}
                {d.duration_ms !== null ? ` · ${d.duration_ms} ms` : ''}
              </Meta>
              <Meta label="Event ID">
                <span className="font-mono text-caption break-all">{d.event_id}</span>
              </Meta>
            </dl>
            <CodeBlock title="Payload">{prettyJson(d.payload)}</CodeBlock>
            <CodeBlock title="Request headers">
              {Object.entries(d.request_headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')}
            </CodeBlock>
            <CodeBlock title="Response body">{d.response_body_excerpt || '(empty)'}</CodeBlock>
          </>
        )
      )}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="min-w-0 text-text-primary">{children}</dd>
    </>
  );
}

function CodeBlock({ title, children }: { title: string; children: string }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="text-caption font-medium text-text-muted uppercase">{title}</h3>
      <pre className="max-h-72 overflow-auto rounded-md bg-surface-subtle p-3 font-mono text-caption whitespace-pre-wrap break-all text-text-primary">{children}</pre>
    </section>
  );
}
