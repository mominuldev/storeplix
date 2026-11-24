import { WEBHOOK_EVENT_TYPES, type WebhookEndpoint, type WebhookEventTypeInfo } from '@storeplix/types';
import { Badge, Button, cn, Dialog, EmptyState } from '@storeplix/ui';
import { Pencil, Power, Send, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, ErrorBlock } from '../catalog/states';
import { clock, timeAgo } from '../commerce/format';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { endpointStatusLine, successPill } from './developer';
import { EndpointModal } from './EndpointModal';
import { useDeleteEndpoint, useSetEndpointActive, useTestEndpoint, useWebhookEndpoints } from './queries';
import { cellClass, DevCard, DevTable, RowMenu, TableSkeleton, Tag, TagList } from './ui';

// Figma Card / Webhooks 144:41424: ENDPOINT (url truncated + "Last delivery 2 min ago · 200 OK" or red "Failing since
// 09:40 · 503 Service unavailable"), EVENTS (first 2 + "+n"), SUCCESS · 7 DAYS pill, row menu (Edit, Send test event,
// Disable/Enable, Delete); footer "Events you can send:" from the catalogue.

const columns = [{ label: 'Endpoint' }, { label: 'Events', className: 'w-[236px]' }, { label: 'Success · 7 days', className: 'w-[136px]' }, { label: '', className: 'w-11' }];

export function WebhooksCard({ locked, eventTypes }: { locked: boolean; eventTypes: WebhookEventTypeInfo[] | undefined }) {
  const endpoints = useWebhookEndpoints();
  const [editing, setEditing] = useState<WebhookEndpoint | 'new' | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const test = useTestEndpoint();
  const setActive = useSetEndpointActive();
  const onError = (fallback: string) => (e: unknown) => {
    if (!handlePlanLimit(e)) toast(errorMessage(e, fallback), 'error');
  };
  const catalogue = eventTypes?.map((t) => t.key) ?? WEBHOOK_EVENT_TYPES;

  return (
    <DevCard
      title="Webhooks"
      description="We POST a signed JSON event to your URL. Failed deliveries retry for 24 hours."
      action={
        <ReadOnlyActions>
          <Button size="sm" variant="secondary" onClick={() => setEditing('new')} disabled={locked}>
            + Add endpoint
          </Button>
        </ReadOnlyActions>
      }
    >
      {endpoints.isPending ? (
        <TableSkeleton label="Loading webhook endpoints" />
      ) : endpoints.isError ? (
        <ErrorBlock title="We couldn’t load your webhooks" error={endpoints.error} onRetry={() => void endpoints.refetch()} />
      ) : endpoints.data.length === 0 ? (
        <div className="rounded-lg border border-border-default">
          <EmptyState
            icon={<Webhook />}
            title="No endpoints yet"
            description="Add a URL and we’ll send it new orders, payments, shipments and more as they happen."
            action={
              !locked && (
                <ReadOnlyActions>
                  <Button size="sm" onClick={() => setEditing('new')}>
                    Add endpoint
                  </Button>
                </ReadOnlyActions>
              )
            }
          />
        </div>
      ) : (
        <DevTable label="Webhook endpoints" columns={columns} minWidth={640}>
          {endpoints.data.map((e) => {
            const line = endpointStatusLine(e, (iso) => timeAgo(iso), clock);
            const pill = successPill(e);
            return (
              <tr key={e.id}>
                <td className={cellClass}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className={cn('truncate text-body font-medium', e.is_active ? 'text-text-primary' : 'text-text-muted')} title={e.url}>
                      {e.url}
                    </span>
                    <span className={cn('truncate text-caption', line.danger ? 'text-danger' : 'text-text-secondary')}>{line.text}</span>
                  </div>
                </td>
                <td className={cellClass}>
                  <TagList items={e.events.map((ev) => ({ key: ev, label: ev }))} />
                </td>
                <td className={cellClass}>
                  {e.is_active ? (
                    <Badge tone={pill.tone} dot>
                      {pill.label}
                    </Badge>
                  ) : (
                    <Badge dot>Off</Badge>
                  )}
                </td>
                <td className={cellClass}>
                  <ReadOnlyActions>
                    <RowMenu
                      label={`Actions for ${e.url}`}
                      disabled={locked}
                      entries={[
                        { key: 'edit', label: 'Edit…', icon: <Pencil />, onSelect: () => setEditing(e) },
                        {
                          key: 'test',
                          label: 'Send test event',
                          icon: <Send />,
                          disabled: !e.is_active,
                          onSelect: () => test.mutate(e.id, { onSuccess: () => toast('Test event sent.'), onError: onError('We couldn’t send the test event.') }),
                        },
                        {
                          key: 'toggle',
                          label: e.is_active ? 'Disable' : 'Enable',
                          icon: <Power />,
                          onSelect: () =>
                            setActive.mutate(
                              { id: e.id, active: !e.is_active },
                              { onSuccess: () => toast(e.is_active ? 'Endpoint turned off.' : 'Endpoint turned on.'), onError: onError('We couldn’t change the endpoint.') },
                            ),
                        },
                        { kind: 'separator', key: 'sep' },
                        { key: 'delete', label: 'Delete…', icon: <Trash2 />, danger: true, onSelect: () => setDeleting(e) },
                      ]}
                    />
                  </ReadOnlyActions>
                </td>
              </tr>
            );
          })}
        </DevTable>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-caption text-text-secondary">Events you can send:</span>
        {catalogue.map((k) => (
          <Tag key={k}>{k}</Tag>
        ))}
      </div>
      {editing && <EndpointModal endpoint={editing === 'new' ? null : editing} eventTypes={eventTypes} onClose={() => setEditing(null)} />}
      {deleting && <DeleteEndpointDialog endpoint={deleting} onClose={() => setDeleting(null)} />}
    </DevCard>
  );
}

function DeleteEndpointDialog({ endpoint, onClose }: { endpoint: WebhookEndpoint; onClose: () => void }) {
  const remove = useDeleteEndpoint();
  return (
    <Dialog
      open
      tone="danger"
      icon={<Trash2 />}
      title="Delete this endpoint?"
      description={
        <>
          We stop sending events to <span className="break-all font-medium text-text-primary">{endpoint.url}</span> and delete its delivery log.
        </>
      }
      confirmLabel="Delete endpoint"
      loading={remove.isPending}
      onCancel={onClose}
      onConfirm={() =>
        remove.mutate(endpoint.id, {
          onSuccess: () => {
            toast('Endpoint deleted.');
            onClose();
          },
          onError: (e) => {
            if (!handlePlanLimit(e)) toast(errorMessage(e, 'We couldn’t delete the endpoint. Try again.'), 'error');
          },
        })
      }
    />
  );
}
