import { zodResolver } from '@hookform/resolvers/zod';
import type { AdminSenderIdRequest } from '@storeplix/types';
import { Badge, Button, Checkbox, Chip, Dialog, Drawer, Skeleton } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Eye, FileText } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { LoggedAs } from '../components/LoggedAs';
import { ReasonDialog } from '../components/ReasonDialog';
import { ReasonField } from '../components/ReasonField';
import { reasonSchema } from '../components/reason';
import { ErrorState } from '../components/States';
import { api } from '../lib/api';
import { saveBlob } from '../lib/download';
import { errorMessage } from '../lib/errors';
import { formatDateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { formatBytes, mimeLabel, rejectReasons, senderIdChecks, senderIdStatusMeta, usesLabel } from './format';
import { smsKeys } from './queries';

// Review drawer 2095:8922 (PHASE-8-9A §13.1, §8.3): header ID + status pill + shop; REQUEST facts; AUTOMATIC CHECKS
// (pending only); DOCUMENTS (licence streamed from the authenticated admin endpoint, saved as an attachment — never
// a public URL); "Before you approve" steps; reject reason chips + textarea (required, shown to the merchant); footer
// "Logged as …" + Reject / Approve. Approve opens a confirm with the "Registered on REVE SMS / BTRC" tick + an
// internal reason. Approved requests get Revoke (reason shown to the merchant). 409s show inline.
export function SenderIdDrawer({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'approve' | 'revoke' | null>(null);
  const [chip, setChip] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const request = useQuery({
    queryKey: smsKeys.senderId(requestId),
    queryFn: () => api.admin.senderIds.get(requestId),
  });
  const r = request.data;

  const done = (updated: AdminSenderIdRequest, message: string) => {
    queryClient.setQueryData(smsKeys.senderId(requestId), updated);
    void queryClient.invalidateQueries({ queryKey: smsKeys.senderIds });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', updated.tenant.id, 'audit'] });
    toast(message);
  };

  const download = useMutation({
    mutationFn: () => api.admin.senderIds.document(requestId, r?.document.filename),
    onSuccess: (file) => saveBlob(file.blob, file.filename),
  });
  const reject = useMutation({
    mutationFn: (text: string) => api.admin.senderIds.reject(requestId, { reason: text }),
    onSuccess: (updated) => {
      done(updated, `${updated.sender_id} rejected · the owner was emailed`);
      onClose();
    },
  });

  const submitReject = () => {
    const parsed = reasonSchema.safeParse(reason);
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? 'Enter a reason');
      return;
    }
    setReasonError(null);
    reject.mutate(parsed.data);
  };

  const pending = r?.status === 'pending';
  const approved = r?.status === 'approved';
  const meta = r ? senderIdStatusMeta[r.status] : null;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        width={560}
        title={
          r && meta ? (
            <span className="flex items-center gap-2.5">
              <span className="truncate">{r.sender_id}</span>
              <Badge size="sm" dot tone={meta.tone}>
                {meta.label}
              </Badge>
            </span>
          ) : (
            'Sender ID request'
          )
        }
        description={r ? `${r.tenant.name} · ${r.tenant.slug}` : undefined}
        footer={
          r && (
            <>
              <span className="flex-1">
                <LoggedAs />
              </span>
              {pending && (
                <>
                  <Button variant="danger" onClick={submitReject} loading={reject.isPending}>
                    Reject
                  </Button>
                  <Button onClick={() => setDialog('approve')} disabled={reject.isPending}>
                    Approve
                  </Button>
                </>
              )}
              {approved && (
                <Button variant="danger" onClick={() => setDialog('revoke')}>
                  Revoke
                </Button>
              )}
            </>
          )
        }
      >
        {request.isPending ? (
          <div role="status" aria-label="Loading request" className="flex flex-col gap-3 px-7 py-5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-28 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        ) : request.isError ? (
          <ErrorState error={request.error} onRetry={() => void request.refetch()} title="We couldn’t load this request" />
        ) : (
          r && (
            <div className="flex flex-col gap-5 px-5 py-5 sm:px-7">
              <section aria-label="Request" className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-caption font-medium text-text-muted uppercase">Request</h3>
                  <Link to={`/merchants/${r.tenant.id}`} className="text-body font-medium text-brand-600 hover:underline">
                    Open shop
                  </Link>
                </div>
                <dl className="flex flex-col gap-2">
                  <Fact label="Requested ID" value={r.sender_id} />
                  <Fact label="Purpose" value={usesLabel(r.uses)} />
                  <Fact label="Name on licence" value={r.business_name} />
                  <Fact
                    label="Submitted"
                    value={`${formatDateTime(r.requested_at)}${r.requested_by ? ` by ${r.requested_by.name}` : ''}${r.requested_by_email ? ` (${r.requested_by_email})` : ''}`}
                  />
                  {pending && <Fact label="Sends now as" value={r.current_sender_id ?? 'Storeplix (platform default)'} />}
                  {r.note && <Fact label="Merchant note" value={r.note} />}
                  {r.reviewed_at && <Fact label="Reviewed" value={`${formatDateTime(r.reviewed_at)}${r.reviewed_by ? ` by ${r.reviewed_by.name}` : ''}`} />}
                  {r.decision_reason && <Fact label="Reason given" value={r.decision_reason} />}
                </dl>
              </section>

              {pending && (
                <section aria-label="Automatic checks" className="flex flex-col gap-2">
                  <h3 className="text-caption font-medium text-text-muted uppercase">Automatic checks</h3>
                  <ul className="flex flex-col gap-2">
                    {senderIdChecks(r.sender_id, r.tenant.name, r.business_name).map((c) => (
                      <li key={c.label} className="flex items-center gap-2 text-body text-text-primary">
                        {c.ok ? <Check aria-label="Passed" className="size-4 shrink-0 text-success" /> : <AlertTriangle aria-label="Check" className="size-4 shrink-0 text-warning" />}
                        {c.label}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section aria-label="Documents" className="flex flex-col gap-2">
                <h3 className="text-caption font-medium text-text-muted uppercase">Documents</h3>
                <div className="flex items-center gap-2.5 rounded-control border border-border-default px-3 py-2.5">
                  <FileText aria-hidden className="size-[18px] shrink-0 text-brand-600" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-medium text-text-primary">{r.document.filename}</span>
                    <span className="truncate text-caption text-text-secondary">
                      Trade licence · {formatBytes(r.document.size_bytes)} · {mimeLabel(r.document.mime)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => download.mutate()}
                    disabled={download.isPending}
                    className="flex shrink-0 items-center gap-1.5 rounded-sm text-body font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus disabled:opacity-60"
                  >
                    <Eye aria-hidden className="size-4" />
                    {download.isPending ? 'Opening…' : 'Open'}
                  </button>
                </div>
                {download.isError && (
                  <p role="alert" className="text-caption text-danger">
                    {errorMessage(download.error)}
                  </p>
                )}
              </section>

              {pending && (
                <>
                  <div className="flex flex-col gap-1 rounded-control bg-info-bg px-3.5 py-3 text-caption">
                    <span className="font-medium text-info">Before you approve</span>
                    <span className="text-text-primary">
                      1. Check the licence name matches. 2. Register {r.sender_id} in the REVE SMS portal. 3. Approve here only when REVE shows it
                      as active — the shop switches to {r.sender_id} right away.
                    </span>
                  </div>

                  <section aria-label="Reject reason" className="flex flex-col gap-2">
                    <p className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="text-body font-medium text-text-primary">Reason if you reject</span>
                      <span className="text-caption text-text-muted">Required to reject · shown to the merchant</span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {rejectReasons.map((c) => (
                        <Chip
                          key={c.key}
                          check={false}
                          selected={chip === c.key}
                          onClick={() => {
                            setChip(c.key);
                            setReason(c.text(r.sender_id));
                            setReasonError(null);
                          }}
                        >
                          {c.label}
                        </Chip>
                      ))}
                    </div>
                    <ReasonField
                      label="Reason"
                      hint="The merchant sees this and it is emailed to the owner"
                      aria-label="Reason if you reject"
                      value={reason}
                      error={reasonError ?? undefined}
                      onChange={(e) => {
                        setReason(e.target.value);
                        if (reasonError) setReasonError(null);
                      }}
                      className="min-h-[96px]"
                    />
                    {reject.isError && (
                      <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
                        {errorMessage(reject.error)}
                      </p>
                    )}
                  </section>
                </>
              )}
            </div>
          )
        )}
      </Drawer>
      {dialog === 'approve' && r && (
        <ApproveDialog
          request={r}
          onCancel={() => setDialog(null)}
          onDone={(updated) => {
            setDialog(null);
            done(updated, `${updated.sender_id} approved · the shop now sends as ${updated.sender_id}`);
          }}
        />
      )}
      {dialog === 'revoke' && r && (
        <ReasonDialog
          title={`Revoke ${r.sender_id}?`}
          description={`${r.tenant.name} goes back to the shared Storeplix sender with the “${r.tenant.name}: ” prefix. The owner is emailed.`}
          confirmLabel="Revoke sender ID"
          tone="danger"
          reasonLabel="Reason"
          reasonHint="Shown to the merchant · saved to the audit log"
          onCancel={() => setDialog(null)}
          onSubmit={(text) => api.admin.senderIds.revoke(r.id, text)}
          onDone={(updated) => {
            setDialog(null);
            done(updated, `${updated.sender_id} revoked`);
          }}
        />
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-body">
      <dt className="w-[140px] shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 flex-1 font-medium break-words text-text-primary">{value}</dd>
    </div>
  );
}

const approveSchema = z.object({
  provider_registered: z.boolean().refine((v) => v, 'Confirm the ID is registered and active on REVE SMS first'),
  reason: reasonSchema,
});
type ApproveValues = z.infer<typeof approveSchema>;

/** §8.3 approve: `provider_registered: true` (the tick) + reason 5–500 (internal). 409 `sender_id_taken` inline. */
export function ApproveDialog({ request, onCancel, onDone }: { request: AdminSenderIdRequest; onCancel: () => void; onDone: (r: AdminSenderIdRequest) => void }) {
  const formId = useId();
  const { register, handleSubmit, formState } = useForm<ApproveValues>({
    resolver: zodResolver(approveSchema),
    defaultValues: { provider_registered: false, reason: '' },
  });
  const mutation = useMutation({
    mutationFn: (v: ApproveValues) => api.admin.senderIds.approve(request.id, { provider_registered: true, reason: v.reason.trim() }),
    onSuccess: onDone,
  });
  return (
    <Dialog
      open
      title={`Approve ${request.sender_id}?`}
      description={`${request.tenant.name} starts sending as ${request.sender_id} right away${
        request.current_sender_id ? `, replacing ${request.current_sender_id}` : ''
      }. The owner is emailed.`}
      confirmLabel="Approve"
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      size="md"
      onConfirm={() => undefined}
      onCancel={onCancel}
    >
      <form id={formId} noValidate onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Checkbox label={`Registered on REVE SMS / BTRC — ${request.sender_id} shows as active`} {...register('provider_registered')} />
          {formState.errors.provider_registered && (
            <p role="alert" className="text-caption text-danger">
              {formState.errors.provider_registered.message}
            </p>
          )}
        </div>
        <ReasonField error={formState.errors.reason?.message} {...register('reason')} />
        {mutation.isError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
            {errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
