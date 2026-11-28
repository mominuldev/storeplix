import { isApiError } from '@storeplix/api-client';
import {
  PLATFORM_SMS_STOP_FOOTER,
  type PlatformSmsAudience,
  type PlatformSmsAudienceCounts,
  type PlatformSmsBroadcast,
  type PlatformSmsBroadcastEstimate,
  type PlatformSmsBroadcastInput,
  type PlatformSmsBroadcastStatus,
  type SubscriptionStatus,
} from '@storeplix/types';
import { Badge, Button, Checkbox, Chip, cn, Dialog, Drawer, formatBdt, formatCount, Input, KpiTile, Menu, Modal, Pagination, SegmentedControl, Skeleton } from '@storeplix/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, Megaphone, MoreHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import { CursorFooter } from '../../audit/CursorFooter';
import { useCursorPages } from '../../audit/useCursorPages';
import { LoggedAs } from '../../components/LoggedAs';
import { Empty, ErrorState, LoadingRows } from '../../components/States';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useDebounced } from '../../lib/useDebounced';
import { useToast } from '../../lib/toast';
import {
  AUDIENCE_STATUSES,
  audienceLabel,
  audienceReady,
  BROADCAST_MERGE_FIELDS,
  broadcastStatusMeta,
  countBroadcast,
  dhakaDay,
  dhakaToIso,
  insertAt,
  parseTypedCount,
  recipientStatusMeta,
  scheduleProblem,
  scheduleProblemText,
  skippedLine,
  skipReasonLabel,
  subscriptionStatusLabel,
  templateProblem,
  templateProblemText,
  withinSendingHours,
} from './format';
import { platformSmsKeys, smsErrorText } from './queries';
import { InlineAlert, SectionCard, SummaryList, TestSmsDialog } from './ui';

// Broadcasts tab (PHASE-8-9B §11.5, Figma 2098:9969; confirm 2103:9134). KPI strip; New broadcast card (route pill,
// internal name, bn + en bodies with merge chips and the locked STOP footer line — Figma "STOP লিখে 16xxx-এ পাঠান"
// restyled as a link, Q281 —, audience radio cards + sub-chips, When (Send now / Schedule, GMT+6, 9 AM–9 PM),
// debounced Estimate panel); Confirm dialog with acknowledge + "Type {n} to confirm" (Q280); Past broadcasts with
// status chips, row menu and a recipients drawer.

type When = 'now' | 'schedule';
interface Form {
  id: string | null;
  revision: number;
  name: string;
  body_bn: string;
  body_en: string;
  audience: PlatformSmsAudience;
  when: When;
  day: string;
  time: string;
}

const emptyForm = (): Form => ({
  id: null,
  revision: 0,
  name: '',
  body_bn: '',
  body_en: '',
  audience: { kind: 'all' },
  when: 'schedule',
  day: dhakaDay(new Date(Date.now() + 86_400_000)),
  time: '10:00',
});

function fromBroadcast(b: PlatformSmsBroadcast): Form {
  const at = b.scheduled_at ? new Date(b.scheduled_at) : null;
  return {
    id: b.id,
    revision: b.revision,
    name: b.name,
    body_bn: b.body_bn,
    body_en: b.body_en,
    audience: b.audience,
    when: at ? 'schedule' : 'now',
    day: at ? dhakaDay(at) : emptyForm().day,
    time: at ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: false }).format(at) : '10:00',
  };
}

export function BroadcastsTab() {
  const [form, setForm] = useState<Form>(emptyForm);
  const [formKey, setFormKey] = useState(0);
  const composer = useRef<HTMLDivElement>(null);
  const edit = (b: PlatformSmsBroadcast) => {
    setForm(fromBroadcast(b));
    setFormKey((k) => k + 1);
    composer.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="flex flex-col gap-5">
      <Kpis />
      <div ref={composer}>
        <Composer
          key={formKey}
          form={form}
          setForm={setForm}
          onReset={() => {
            setForm(emptyForm());
            setFormKey((k) => k + 1);
          }}
        />
      </div>
      <PastBroadcasts onEdit={edit} />
    </div>
  );
}

function Kpis() {
  const q = useQuery({ queryKey: platformSmsKeys.broadcasts({ per_page: 1 }), queryFn: () => api.admin.platformSms.broadcasts.list({ per_page: 1 }) });
  const k = q.data?.meta.kpis;
  const v = (x: string) => (q.isPending ? <Skeleton className="h-7 w-16" /> : x);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiTile label="Broadcasts this month" value={v(formatCount(k?.broadcasts_this_month ?? 0))} />
      <KpiTile label="Sent successfully" value={v(k?.sent_success_rate != null ? `${k.sent_success_rate}%` : '—')} />
      <KpiTile label="Opted out" value={v(formatCount(k?.opted_out_total ?? 0))} hint="Merchants who stopped offers" />
      <KpiTile label="Promotional spend" value={v(formatBdt(k?.spend_this_month_paisa ?? 0))} hint="This month (estimate)" />
    </div>
  );
}

function Composer({ form, setForm, onReset }: { form: Form; setForm: (f: Form | ((f: Form) => Form)) => void; onReset: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [language, setLanguage] = useState<'bn' | 'en'>('bn');
  const [showErrors, setShowErrors] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirm, setConfirm] = useState<{ broadcast: PlatformSmsBroadcast; estimate: PlatformSmsBroadcastEstimate } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const overview = useQuery({ queryKey: platformSmsKeys.overview, queryFn: () => api.admin.platformSms.providers.overview() });
  const audiences = useQuery({ queryKey: platformSmsKeys.audiences, queryFn: () => api.admin.platformSms.broadcasts.audiences() });

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const bodyKey = language === 'bn' ? 'body_bn' : 'body_en';
  const body = form[bodyKey];
  const counts = { bn: countBroadcast(form.body_bn, 'bn'), en: countBroadcast(form.body_en, 'en') };
  const count = counts[language];
  const problems = {
    bn: templateProblem(form.body_bn, BROADCAST_MERGE_FIELDS, [], counts.bn),
    en: templateProblem(form.body_en, BROADCAST_MERGE_FIELDS, [], counts.en),
  };
  const nameError = form.name.trim().length < 2 || form.name.trim().length > 80 ? 'Use 2–80 characters.' : null;
  const schedErr = form.when === 'schedule' ? scheduleProblem(form.day, form.time) : null;
  const nowOutside = form.when === 'now' && !withinSendingHours(new Date());
  const ready = audienceReady(form.audience);
  const valid = !nameError && !problems.bn && !problems.en && ready && !schedErr;

  const estimateInput = { audience: form.audience, body_bn: form.body_bn.trim(), body_en: form.body_en.trim() };
  const debounced = useDebounced(JSON.stringify(estimateInput), 500);
  const estimateEnabled = ready && !problems.bn && !problems.en;
  const estimate = useQuery({
    queryKey: [...platformSmsKeys.root, 'estimate', debounced],
    queryFn: ({ signal }) => api.admin.platformSms.broadcasts.estimate(JSON.parse(debounced) as typeof estimateInput, { signal }),
    enabled: estimateEnabled,
    placeholderData: keepPreviousData,
  });
  const e = estimateEnabled ? estimate.data : undefined;

  const input = (): PlatformSmsBroadcastInput => ({
    name: form.name.trim(),
    body_bn: form.body_bn.trim(),
    body_en: form.body_en.trim(),
    audience: form.audience,
    scheduled_at: form.when === 'now' ? null : dhakaToIso(form.day, form.time),
  });
  const saveDraft = useMutation({
    mutationFn: () => (form.id ? api.admin.platformSms.broadcasts.update(form.id, { ...input(), revision: form.revision }) : api.admin.platformSms.broadcasts.create(input())),
    onSuccess: (b) => {
      set({ id: b.id, revision: b.revision });
      void qc.invalidateQueries({ queryKey: [...platformSmsKeys.root, 'broadcasts'] });
    },
  });
  const review = useMutation({
    mutationFn: async () => {
      const b = await saveDraft.mutateAsync();
      const est = await api.admin.platformSms.broadcasts.estimate({ audience: b.audience, body_bn: b.body_bn, body_en: b.body_en });
      return { broadcast: b, estimate: est };
    },
    onSuccess: setConfirm,
  });

  const insert = (field: string) => {
    const el = textarea.current;
    const next = insertAt(body, field, el?.selectionStart ?? body.length, el?.selectionEnd ?? body.length);
    set({ [bodyKey]: next.body } as Partial<Form>);
    el?.focus();
  };
  const submit = (fn: () => void) => {
    if (!valid) {
      setShowErrors(true);
      return;
    }
    fn();
  };

  const promo = overview.data?.primary?.message_groups.includes('promotional') ? overview.data.primary : overview.data?.failover?.message_groups.includes('promotional') ? overview.data.failover : null;
  const currentProblem = problems[language];

  return (
    <SectionCard
      title={form.id ? `Edit draft · ${form.name || 'Untitled'}` : 'New broadcast'}
      description={`Promotional SMS to merchants${promo?.promotional_sender_id ? `, sent from the ${promo.promotional_sender_id} mask` : ''}, 9 AM – 9 PM only.`}
      actions={
        <Badge size="sm" tone={promo?.promotional_sender_status === 'approved' ? 'warning' : 'danger'}>
          {promo?.promotional_sender_id ? `Promotional route · ${promo.promotional_sender_status === 'approved' ? 'Approved' : 'Pending BTRC'}` : 'No promotional mask'}
        </Badge>
      }
    >
      <Input label="Name (only admins see it)" value={form.name} onChange={(ev) => set({ name: ev.target.value })} error={showErrors && nameError ? nameError : undefined} />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="broadcast-body" className="flex-1 text-body font-medium text-text-primary">
            Message
          </label>
          <div role="group" aria-label="Broadcast language" className="flex gap-2">
            {(
              [
                ['bn', 'বাংলা'],
                ['en', 'English'],
              ] as const
            ).map(([value, label]) => (
              <Chip key={value} selected={language === value} check={false} className={value === 'bn' ? 'font-bangla' : undefined} onClick={() => setLanguage(value)}>
                {label}
                {!problems[value] && <Check aria-label="written" className="size-3.5 text-success" />}
              </Chip>
            ))}
          </div>
        </div>
        <div className={cn('flex flex-col gap-2 rounded-control border bg-surface-card p-2 focus-within:border-brand-600 focus-within:shadow-focus', showErrors && currentProblem ? 'border-danger' : 'border-border-default')}>
          <textarea
            id="broadcast-body"
            ref={textarea}
            rows={3}
            value={body}
            onChange={(ev) => set({ [bodyKey]: ev.target.value } as Partial<Form>)}
            className={cn('w-full resize-y bg-transparent px-1 text-body text-text-primary outline-none', language === 'bn' && 'font-bangla leading-[22px]')}
          />
          <p className="flex flex-wrap items-center gap-1.5 rounded-md bg-surface-subtle px-2 py-1.5 text-caption text-text-muted" data-testid="stop-footer">
            <Lock aria-hidden className="size-3" />
            <span className={cn('flex-1', language === 'bn' && 'font-bangla')}>{PLATFORM_SMS_STOP_FOOTER[language].replace('{url}', '{link}')}</span>
            <span>Added to every promotional SMS</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-text-muted">Insert</span>
          {BROADCAST_MERGE_FIELDS.map((f) => (
            <button key={f} type="button" onClick={() => insert(f)} className="rounded-full bg-brand-50 px-2 py-0.5 text-caption font-medium text-brand-700 outline-none hover:bg-brand-100 focus-visible:shadow-focus">
              {`{${f}}`}
            </button>
          ))}
          <span className="flex-1" />
          <span className={cn('text-caption', count.parts > 3 ? 'text-danger' : 'text-brand-600')} data-testid="broadcast-counter">
            {count.characters} characters incl. footer · {count.parts} SMS part{count.parts === 1 ? '' : 's'} ({count.encoding === 'ucs2' ? 'Unicode' : 'GSM'})
          </span>
        </div>
        {(showErrors || (currentProblem && currentProblem.code !== 'empty')) && currentProblem && <p className="text-caption text-danger">{templateProblemText(currentProblem)}</p>}
        <p className="text-caption text-text-muted">Each merchant gets the version in their shop’s SMS language. Both versions are required.</p>
      </div>

      <AudiencePicker value={form.audience} onChange={(audience) => set({ audience })} counts={audiences.data} loading={audiences.isPending} showErrors={showErrors} />
      {e && skippedLine(e.skipped) && <p className="rounded-md bg-surface-subtle px-3 py-2 text-caption text-text-secondary">Skipped automatically: {skippedLine(e.skipped)}.</p>}

      <div className="grid gap-5 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <span className="text-body font-medium text-text-primary">When</span>
          <SegmentedControl<When>
            aria-label="When"
            value={form.when}
            onChange={(when) => set({ when })}
            options={[
              { value: 'now', label: 'Send now' },
              { value: 'schedule', label: 'Schedule' },
            ]}
          />
          {form.when === 'schedule' ? (
            <div className="grid grid-cols-2 gap-3">
              <Input label="Date" type="date" value={form.day} min={dhakaDay()} onChange={(ev) => set({ day: ev.target.value })} />
              <Input label="Time" type="time" value={form.time} min="09:00" max="20:59" onChange={(ev) => set({ time: ev.target.value })} />
            </div>
          ) : null}
          {schedErr ? (
            <p className="text-caption text-danger">{scheduleProblemText[schedErr]}</p>
          ) : nowOutside ? (
            <p className="text-caption text-warning">It’s outside 9 AM – 9 PM now, so “Send now” will be refused. Schedule it instead.</p>
          ) : (
            <p className="text-caption text-text-muted">Bangladesh time (GMT+6). Promotional SMS only go out 9 AM – 9 PM; a broadcast still sending at 9 PM pauses until 9 AM.</p>
          )}
        </div>
        <EstimatePanel estimate={e} loading={estimateEnabled && estimate.isFetching && !e} error={estimateEnabled && estimate.isError ? smsErrorText(estimate.error) : null} />
      </div>

      {(saveDraft.isError || review.isError) && <InlineAlert tone="danger">{smsErrorText(review.error ?? saveDraft.error)}</InlineAlert>}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => (problems.bn || problems.en ? setShowErrors(true) : setTesting(true))}>
          Send test to me
        </Button>
        {form.id && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            New broadcast instead
          </Button>
        )}
        <span className="flex-1" />
        <Button
          variant="secondary"
          loading={saveDraft.isPending && !review.isPending}
          onClick={() => submit(() => saveDraft.mutate(undefined, { onSuccess: () => toast('Draft saved') }))}
        >
          Save draft
        </Button>
        <Button loading={review.isPending} onClick={() => submit(() => review.mutate())}>
          Review and schedule
        </Button>
      </div>

      {testing && (
        <TestSmsDialog
          title="Send this broadcast to me"
          description={`${language === 'bn' ? 'বাংলা' : 'English'} version with sample data and a test STOP link.`}
          onClose={() => setTesting(false)}
          send={(phone) => api.admin.platformSms.broadcasts.test({ language, phone, body_bn: form.body_bn.trim(), body_en: form.body_en.trim() })}
          renderResult={(r) => (
            <p role="status" className="rounded-lg bg-success-bg px-3 py-2.5 text-body text-text-primary">
              Test {r.status === 'failed' ? 'failed' : 'sent'} to {r.to_masked} · {r.parts} part{r.parts === 1 ? '' : 's'}
            </p>
          )}
        />
      )}
      {confirm && (
        <ConfirmBroadcastDialog
          broadcast={confirm.broadcast}
          estimate={confirm.estimate}
          counts={audiences.data}
          onClose={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null);
            onReset();
          }}
        />
      )}
    </SectionCard>
  );
}

function AudiencePicker({
  value,
  onChange,
  counts,
  loading,
  showErrors,
}: {
  value: PlatformSmsAudience;
  onChange: (a: PlatformSmsAudience) => void;
  counts: PlatformSmsAudienceCounts | undefined;
  loading: boolean;
  showErrors: boolean;
}) {
  const cards: { kind: PlatformSmsAudience['kind']; title: string; detail: string }[] = [
    { kind: 'all', title: 'All merchants', detail: counts ? `${formatCount(counts.all)} shops` : '…' },
    { kind: 'plan', title: 'By plan', detail: counts ? counts.plans.map((p) => p.name).join(', ') : '…' },
    { kind: 'status', title: 'By status', detail: 'Active, trial, past due…' },
    { kind: 'trial_ending', title: 'Trial ending', detail: counts ? `${formatCount(counts.trial_ending)} end in the next 7 days` : '…' },
  ];
  const toggle = <T extends string>(list: T[] | undefined, v: T) => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]);
  return (
    <div className="flex flex-col gap-3">
      <span className="text-body font-medium text-text-primary">Audience</span>
      <div role="radiogroup" aria-label="Audience" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => (
          <label key={c.kind} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5', value.kind === c.kind ? 'border-brand-600 bg-brand-50' : 'border-border-default')}>
            <input
              type="radio"
              name="broadcast-audience"
              className="mt-0.5 size-4 accent-brand-600"
              checked={value.kind === c.kind}
              onChange={() => onChange(c.kind === 'plan' ? { kind: 'plan', plans: [] } : c.kind === 'status' ? { kind: 'status', statuses: [] } : { kind: c.kind })}
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-body font-medium text-text-primary">{c.title}</span>
              <span className="text-caption text-text-secondary">{loading ? '…' : c.detail}</span>
            </span>
          </label>
        ))}
      </div>
      {value.kind === 'plan' && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Plans">
          <span className="text-caption text-text-muted">Plans</span>
          {(counts?.plans ?? []).map((p) => (
            <Chip key={p.code} selected={!!value.plans?.includes(p.code)} onClick={() => onChange({ kind: 'plan', plans: toggle(value.plans, p.code) })}>
              {p.name} · {formatCount(p.count)}
            </Chip>
          ))}
        </div>
      )}
      {value.kind === 'status' && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Subscription statuses">
          <span className="text-caption text-text-muted">Status</span>
          {AUDIENCE_STATUSES.map((st: SubscriptionStatus) => (
            <Chip key={st} selected={!!value.statuses?.includes(st)} onClick={() => onChange({ kind: 'status', statuses: toggle(value.statuses, st) })}>
              {subscriptionStatusLabel[st]}
              {counts ? ` · ${formatCount(counts.statuses[st] ?? 0)}` : ''}
            </Chip>
          ))}
        </div>
      )}
      {showErrors && !audienceReady(value) && <p className="text-caption text-danger">Pick at least one {value.kind === 'plan' ? 'plan' : 'status'}.</p>}
    </div>
  );
}

function EstimatePanel({ estimate: e, loading, error }: { estimate: PlatformSmsBroadcastEstimate | undefined; loading: boolean; error: string | null }) {
  const rows: [string, string, boolean?][] = e
    ? [
        ['Recipients', `${formatCount(e.recipients)} merchants`],
        ['Parts per SMS', String(e.parts_per_sms)],
        ['Total parts', formatCount(e.total_parts)],
        ['Estimated cost', formatBdt(e.cost_paisa)],
        ['Gateway balance after', e.balance_after_paisa !== null ? formatBdt(e.balance_after_paisa) : 'Unknown', e.below_alert],
      ]
    : [];
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-4 py-3.5" data-testid="broadcast-estimate" aria-live="polite">
      <p className="text-body font-medium text-text-primary">Estimate</p>
      {error ? (
        <p className="text-caption text-danger">{error}</p>
      ) : loading ? (
        <Skeleton className="h-24 w-full" />
      ) : !e ? (
        <p className="text-caption text-text-muted">Write both versions and pick an audience to see the numbers.</p>
      ) : (
        <>
          <dl className="flex flex-col gap-1.5">
            {rows.map(([k, v, warn]) => (
              <div key={k} className="flex justify-between gap-4 text-body">
                <dt className="text-text-secondary">{k}</dt>
                <dd className={cn('font-medium', warn ? 'text-warning' : 'text-text-primary')}>{v}</dd>
              </div>
            ))}
          </dl>
          {e.below_alert && <p className="text-caption text-warning">The balance after this broadcast is below the low-balance alert.</p>}
          {e.sender_status !== 'approved' && <p className="text-caption text-danger">The promotional mask isn’t approved yet — broadcasts can’t be scheduled.</p>}
        </>
      )}
    </div>
  );
}

/** Confirm dialog 2103:9134 + "Type {n} to confirm" (Q280). 409 `broadcast_estimate_changed` refreshes the numbers in place. */
export function ConfirmBroadcastDialog({
  broadcast,
  estimate: initial,
  counts,
  onClose,
  onDone,
}: {
  broadcast: PlatformSmsBroadcast;
  estimate: PlatformSmsBroadcastEstimate;
  counts: PlatformSmsAudienceCounts | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [estimate, setEstimate] = useState(initial);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const [changed, setChanged] = useState(false);
  const [revision, setRevision] = useState(broadcast.revision);
  const typedN = parseTypedCount(typed);
  const matches = typedN === estimate.recipients;
  const when = broadcast.scheduled_at ? formatDateTime(broadcast.scheduled_at) : null;
  const schedule = useMutation({
    mutationFn: () => api.admin.platformSms.broadcasts.schedule(broadcast.id, { acknowledged: true, confirm_recipients: typedN ?? -1, revision }),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: platformSmsKeys.root });
      toast(b.status === 'scheduled' ? `Broadcast scheduled for ${formatDateTime(b.scheduled_at)}` : `Sending to ${formatCount(estimate.recipients)} merchants`);
      onDone();
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'broadcast_estimate_changed' && e.details && typeof e.details === 'object' && 'recipients' in e.details) {
        setEstimate(e.details as unknown as PlatformSmsBroadcastEstimate);
        setTyped('');
        setChanged(true);
      }
      if (isApiError(e) && e.code === 'revision_conflict') {
        void api.admin.platformSms.broadcasts.get(broadcast.id).then((b) => setRevision(b.revision), () => undefined);
      }
    },
  });
  const checks = [
    { ok: estimate.checks.sending_hours, label: 'Inside 9 AM – 9 PM Bangladesh time' },
    { ok: true, label: 'STOP link added to both versions' },
    { ok: true, label: 'Only merchants who haven’t opted out' },
    { ok: true, label: `Weekly cap: nobody gets more than ${estimate.checks.weekly_cap} promotional SMS in 7 days` },
  ];
  const error = schedule.isError && !(isApiError(schedule.error) && schedule.error.code === 'broadcast_estimate_changed') ? smsErrorText(schedule.error) : null;

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<Megaphone />}
      iconClassName="bg-warning-bg text-warning"
      title={when ? 'Schedule this broadcast?' : 'Send this broadcast now?'}
      description={`${formatCount(estimate.recipients)} merchants (${audienceLabel(broadcast.audience, counts)}) get it ${when ? `on ${when}` : 'now'}. ${when ? 'You can cancel until it starts sending.' : ''}`}
      footerStart={<LoggedAs />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={schedule.isPending}>
            Back
          </Button>
          <Button disabled={!ack || !matches || estimate.recipients === 0} loading={schedule.isPending} onClick={() => schedule.mutate()}>
            {when ? `Schedule for ${when}` : `Send to ${formatCount(estimate.recipients)} merchants`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {changed && <InlineAlert tone="warning">The audience changed since the last estimate. Check the new numbers and type the new count.</InlineAlert>}
        <SummaryList
          rows={[
            { label: 'Sender', value: estimate.sender_id ? `${estimate.sender_id} (promotional)` : 'No promotional mask' },
            { label: 'Recipients', value: `${formatCount(estimate.recipients)} merchants` },
            { label: 'Skipped', value: skippedLine(estimate.skipped) || 'None' },
            { label: 'Parts', value: `${estimate.parts_per_sms} per SMS · ${formatCount(estimate.total_parts)} total` },
            { label: 'Estimated cost', value: formatBdt(estimate.cost_paisa) },
            {
              label: 'Gateway balance after',
              value: estimate.balance_after_paisa !== null ? `${formatBdt(estimate.balance_after_paisa)}${estimate.below_alert ? ' — below your alert' : ''}` : 'Unknown',
              tone: estimate.below_alert ? 'warning' : undefined,
            },
          ]}
        />
        <div className="flex flex-col gap-1.5">
          <p className="text-body font-medium text-text-primary">Checked</p>
          <ul className="flex flex-col gap-1 text-caption text-text-secondary">
            {checks.map((c) => (
              <li key={c.label} className="flex items-center gap-1.5">
                <Check aria-hidden className={cn('size-3.5', c.ok ? 'text-success' : 'text-danger')} />
                {c.label}
              </li>
            ))}
          </ul>
        </div>
        <Checkbox label="I checked both language versions and the link." checked={ack} onChange={(ev) => setAck(ev.target.checked)} />
        <Input
          label={`Type ${estimate.recipients} to confirm`}
          inputMode="numeric"
          value={typed}
          onChange={(ev) => setTyped(ev.target.value)}
          hint={matches ? 'Count matches. This is logged with your name.' : 'The number of merchants who will get it.'}
          trailing={matches ? <Check aria-hidden className="text-success" /> : undefined}
        />
        {error && (
          <p role="alert" className="text-caption font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

type Filter = 'all' | 'scheduled' | 'sent' | 'draft';
const FILTER_STATUSES: Record<Filter, PlatformSmsBroadcastStatus[] | undefined> = {
  all: undefined,
  scheduled: ['scheduled', 'sending'],
  sent: ['sent', 'failed', 'cancelled'],
  draft: ['draft'],
};

function PastBroadcasts({ onEdit }: { onEdit: (b: PlatformSmsBroadcast) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [recipientsOf, setRecipientsOf] = useState<PlatformSmsBroadcast | null>(null);
  const [pending, setPending] = useState<{ kind: 'cancel' | 'delete'; b: PlatformSmsBroadcast } | null>(null);
  const filters = { status: FILTER_STATUSES[filter], page, per_page: 10 };
  const audiences = useQuery({ queryKey: platformSmsKeys.audiences, queryFn: () => api.admin.platformSms.broadcasts.audiences() });
  const q = useQuery({ queryKey: platformSmsKeys.broadcasts(filters), queryFn: () => api.admin.platformSms.broadcasts.list(filters), placeholderData: keepPreviousData });
  const act = useMutation({
    mutationFn: async (p: { kind: 'cancel' | 'delete'; b: PlatformSmsBroadcast }) => {
      if (p.kind === 'cancel') await api.admin.platformSms.broadcasts.cancel(p.b.id);
      else await api.admin.platformSms.broadcasts.delete(p.b.id);
    },
    onSuccess: (_r, p) => {
      setPending(null);
      void qc.invalidateQueries({ queryKey: [...platformSmsKeys.root, 'broadcasts'] });
      toast(p.kind === 'cancel' ? 'Broadcast cancelled' : 'Draft deleted');
    },
    onError: (e) => {
      setPending(null);
      toast(smsErrorText(e), 'danger');
    },
  });

  return (
    <SectionCard
      title="Past broadcasts"
      description="Newest first"
      actions={
        <div role="group" aria-label="Broadcast status" className="flex flex-wrap gap-2">
          {(['all', 'scheduled', 'sent', 'draft'] as Filter[]).map((f) => (
            <Chip
              key={f}
              selected={filter === f}
              check={false}
              onClick={() => {
                setFilter(f);
                setPage(1);
              }}
            >
              {{ all: 'All', scheduled: 'Scheduled', sent: 'Sent', draft: 'Drafts' }[f]}
            </Chip>
          ))}
        </div>
      }
    >
      {q.isPending ? (
        <LoadingRows label="Loading broadcasts" rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.data.length === 0 ? (
        <Empty icon={<Megaphone />} title={filter === 'all' ? 'No broadcasts yet' : 'No broadcasts match'} description="Write one above and schedule it within 9 AM – 9 PM." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border-default max-md:hidden">
            <table className="w-full min-w-[760px] text-left text-body">
              <thead className="bg-surface-subtle text-caption text-text-muted">
                <tr>
                  {['BROADCAST', 'AUDIENCE', 'SENT / SCHEDULED', 'RECIPIENTS', 'SENT OK', 'FAILED', 'STATUS', ''].map((h) => (
                    <th key={h} className="px-3 py-2.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.data.map((b) => (
                  <tr key={b.id} className="border-t border-border-default">
                    <td className="px-3 py-3">
                      <span className="block text-text-primary">{b.name}</span>
                      {b.created_by && <span className="text-caption text-text-muted">by {b.created_by.name}</span>}
                    </td>
                    <td className="px-3 py-3 text-text-primary">{audienceLabel(b.audience, audiences.data)}</td>
                    <td className="px-3 py-3 text-text-primary">{formatDateTime(b.started_at ?? b.scheduled_at ?? b.created_at)}</td>
                    <td className="px-3 py-3 text-text-primary">{b.status === 'draft' ? '—' : formatCount(b.counts.recipients)}</td>
                    <td className="px-3 py-3 text-text-primary">{b.status === 'draft' || b.status === 'scheduled' ? '—' : formatCount(b.counts.sent)}</td>
                    <td className={cn('px-3 py-3', b.counts.failed > 0 ? 'text-danger' : 'text-text-primary')}>{b.status === 'draft' || b.status === 'scheduled' ? '—' : formatCount(b.counts.failed)}</td>
                    <td className="px-3 py-3">
                      <Badge size="sm" tone={broadcastStatusMeta[b.status].tone}>
                        {broadcastStatusMeta[b.status].label}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <RowMenu b={b} onEdit={onEdit} onRecipients={setRecipientsOf} onAct={setPending} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-2 md:hidden">
            {q.data.data.map((b) => (
              <li key={b.id} className="flex items-start gap-3 rounded-lg border border-border-default p-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-body font-medium text-text-primary">{b.name}</span>
                  <span className="text-caption text-text-muted">
                    {audienceLabel(b.audience, audiences.data)} · {formatDateTime(b.started_at ?? b.scheduled_at ?? b.created_at)}
                  </span>
                  <Badge size="sm" tone={broadcastStatusMeta[b.status].tone} className="self-start">
                    {broadcastStatusMeta[b.status].label}
                  </Badge>
                </div>
                <RowMenu b={b} onEdit={onEdit} onRecipients={setRecipientsOf} onAct={setPending} />
              </li>
            ))}
          </ul>
          <Pagination page={q.data.meta.current_page} perPage={q.data.meta.per_page} total={q.data.meta.total} lastPage={q.data.meta.last_page} noun="broadcasts" onPage={setPage} />
        </>
      )}
      <Dialog
        open={!!pending}
        tone="danger"
        title={pending?.kind === 'cancel' ? 'Cancel this broadcast?' : 'Delete this draft?'}
        description={pending?.kind === 'cancel' ? 'Nobody gets it. You can write it again as a new broadcast.' : 'The draft is deleted.'}
        confirmLabel={pending?.kind === 'cancel' ? 'Cancel broadcast' : 'Delete draft'}
        cancelLabel="Keep"
        loading={act.isPending}
        onConfirm={() => pending && act.mutate(pending)}
        onCancel={() => setPending(null)}
      />
      {recipientsOf && <RecipientsDrawer broadcast={recipientsOf} onClose={() => setRecipientsOf(null)} />}
    </SectionCard>
  );
}

function RowMenu({
  b,
  onEdit,
  onRecipients,
  onAct,
}: {
  b: PlatformSmsBroadcast;
  onEdit: (b: PlatformSmsBroadcast) => void;
  onRecipients: (b: PlatformSmsBroadcast) => void;
  onAct: (p: { kind: 'cancel' | 'delete'; b: PlatformSmsBroadcast }) => void;
}) {
  const entries = [
    ...(b.status === 'draft'
      ? [
          { key: 'edit', label: 'Edit', onSelect: () => onEdit(b) },
          { key: 'delete', label: 'Delete', danger: true, onSelect: () => onAct({ kind: 'delete', b }) },
        ]
      : []),
    ...(b.status === 'scheduled' ? [{ key: 'cancel', label: 'Cancel', danger: true, onSelect: () => onAct({ kind: 'cancel', b }) }] : []),
    ...(b.status !== 'draft' ? [{ key: 'recipients', label: 'View recipients', onSelect: () => onRecipients(b) }] : []),
  ];
  return <Menu label={`Actions for ${b.name}`} trigger={<MoreHorizontal aria-hidden className="size-4" />} entries={entries} />;
}

function RecipientsDrawer({ broadcast, onClose }: { broadcast: PlatformSmsBroadcast; onClose: () => void }) {
  const pages = useCursorPages(broadcast.id);
  const q = useQuery({
    queryKey: platformSmsKeys.recipients(broadcast.id, pages.cursor),
    queryFn: () => api.admin.platformSms.broadcasts.recipients(broadcast.id, { cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });
  return (
    <Drawer open onClose={onClose} width={520} title="Recipients" description={`${broadcast.name} · ${formatCount(broadcast.counts.recipients)} merchants`}>
      {q.isPending ? (
        <div className="p-4">
          <LoadingRows rows={6} />
        </div>
      ) : q.isError ? (
        <div className="p-4">
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : q.data.data.length === 0 ? (
        <div className="p-4">
          <Empty title="No recipients yet" description="Recipients are listed once the broadcast starts sending." />
        </div>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-default">
            {q.data.data.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body text-text-primary">{r.tenant.name}</span>
                  <span className="text-caption text-text-muted">
                    {r.to_masked ?? 'No phone'} · {r.language === 'bn' ? 'বাংলা' : 'English'}
                    {r.parts ? ` · ${r.parts} parts` : ''}
                    {r.skip_reason ? ` · ${skipReasonLabel[r.skip_reason]}` : ''}
                  </span>
                </div>
                <Badge size="sm" tone={recipientStatusMeta[r.status].tone}>
                  {recipientStatusMeta[r.status].label}
                </Badge>
              </li>
            ))}
          </ul>
          <CursorFooter page={pages.page} count={q.data.data.length} hasNext={!!q.data.meta.next_cursor} onPrev={pages.prev} onNext={() => q.data.meta.next_cursor && pages.next(q.data.meta.next_cursor)} />
        </>
      )}
    </Drawer>
  );
}
