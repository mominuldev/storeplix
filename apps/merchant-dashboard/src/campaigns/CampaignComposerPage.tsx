import { isApiError } from '@storeplix/api-client';
import type { Campaign, CampaignChannel, CampaignEstimate, CampaignEstimateInput } from '@storeplix/types';
import { Button, ChoiceCard, cn, Dialog, Input } from '@storeplix/ui';
import { AlertTriangle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { formatCount } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, StateCard } from '../catalog/states';
import { newIdempotencyKey } from '../commerce/format';
import { ConflictDialog, LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { useFeatures } from '../plan/useFeatures';
import { storeDomain } from '../stores/useTenantStore';
import { AudienceSection } from './AudienceSection';
import {
  allowanceLeft,
  allowanceOf,
  audienceProblem,
  campaignsLocked,
  defaultName,
  fromCampaign,
  quietHoursMessage,
  renderSms,
  scheduleProblem,
  toInput,
  tzLabel,
  validateComposer,
  zonedToIso,
  type ComposerState,
  type SampleContext,
} from './campaigns';
import { MessageSection } from './MessageSection';
import { AllowanceCard, PhonePreview } from './PreviewColumn';
import { useAudiencePreview, useCampaign, useCampaignEstimate, useFetchEstimate, useLaunchCampaign, useSaveCampaign, useSendTest } from './queries';
import { CampaignPlanNote, StepCard } from './ui';

// Figma New campaign 70:19774 (Main 70:19776), PHASE-8-5 §8.3. Header (breadcrumb, Save draft, Send test to me,
// Schedule campaign / Send campaign + confirm dialog with recipients and allowance), steps 1 Channel (ChoiceCards SMS +
// Email in the WhatsApp slot), 2 Audience, 3 Message, 4 When to send (store timezone, quiet hours inline); right column
// Preview on phone + Allowance. Hidden: WhatsApp card, ৳ prices, Top up, Expected orders, "Good pick" hint (Q148).
// Below `lg` the preview moves under the form (Q151). Added (not in Figma): a "Campaign name" field — names are
// required by the API and shown in the campaigns list.

export function CampaignComposerPage() {
  const { campaignId } = useParams();
  const location = useLocation();
  const isNew = !campaignId;
  const query = useCampaign(campaignId);
  // After the first save of a new campaign the URL becomes /:id/edit; the form keeps its state (same key) instead of
  // remounting from the server copy.
  const carried = (location.state as { composerKey?: string } | null)?.composerKey;
  if (!isNew && query.isPending) return <LoadingState label="Loading campaign" />;
  if (!isNew && query.isError)
    return (
      <StateCard>
        <ErrorBlock title={isApiError(query.error) && query.error.status === 404 ? 'Campaign not found' : 'We couldn’t load this campaign'} error={query.error} onRetry={() => void query.refetch()} />
        <p className="pb-8 text-center">
          <Link to="/marketing/campaigns" className="font-semibold text-brand-600">
            Back to campaigns
          </Link>
        </p>
      </StateCard>
    );
  const campaign = isNew ? null : (query.data ?? null);
  if (campaign && campaign.status !== 'draft' && campaign.status !== 'scheduled')
    return (
      <StateCard>
        <ErrorBlock title="This campaign can’t be edited" message="Only drafts and scheduled campaigns can be changed. Duplicate it to send again." />
        <p className="pb-8 text-center">
          <Link to={`/marketing/campaigns/${campaign.id}`} className="font-semibold text-brand-600">
            Open the campaign
          </Link>
        </p>
      </StateCard>
    );
  return <Composer key={carried ?? campaign?.id ?? 'new'} campaign={campaign} />;
}

type FieldErrors = Record<string, string>;

/** Which inline error a form change clears. */
const errorFieldOf: Record<keyof ComposerState, string> = {
  name: 'name',
  channel: 'body',
  language: 'body',
  audience: 'audience',
  body: 'body',
  subject: 'subject',
  coupon: 'body',
  product: 'body',
  sendMode: 'scheduled_at',
  date: 'scheduled_at',
  time: 'scheduled_at',
};

function Composer({ campaign }: { campaign: Campaign | null }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const features = useFeatures();
  const [params] = useSearchParams();
  const tz = scope.store?.timezone ?? 'Asia/Dhaka';
  const [f, setF] = useState<ComposerState>(() => {
    const s = fromCampaign(campaign, tz);
    const ch = params.get('channel');
    return !campaign && (ch === 'sms' || ch === 'email') ? { ...s, channel: ch } : s;
  });
  const [saved, setSaved] = useState<Campaign | null>(campaign);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState(false);
  const idemKey = useRef<string | null>(null);
  const patch = (p: Partial<ComposerState>) => {
    setF((x) => ({ ...x, ...p }));
    const touched = new Set(Object.keys(p).map((k) => errorFieldOf[k as keyof ComposerState]));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !touched.has(k))));
  };

  const save = useSaveCampaign();
  const test = useSendTest();
  const launch = useLaunchCampaign((row) => {
    setConfirming(false);
    idemKey.current = null;
    toast(
      row.status === 'sending'
        ? `“${row.name}” is sending.`
        : f.sendMode === 'now'
          ? `“${row.name}” is queued: 3 campaigns are already sending. It starts when one finishes.`
          : `“${row.name}” is scheduled.`,
    );
    navigate(`/marketing/campaigns/${row.id}`);
  });
  const fetchEstimate = useFetchEstimate();
  const [confirmEstimate, setConfirmEstimate] = useState<CampaignEstimate | null>(null);
  const locked = !features.data || campaignsLocked(features.data);
  const editable = !save.isPending && !launch.isPending;

  const store = scope.store;
  const ctx: SampleContext = {
    channel: f.channel,
    language: f.language,
    shopName: store?.name ?? '',
    host: store ? storeDomain(store) : 'yourshop.storeplix.com',
    couponCode: f.coupon?.code ?? null,
    product: f.product,
  };
  const sms = useMemo(() => renderSms(f.body, ctx), [f.body, ctx.channel, ctx.language, ctx.shopName, ctx.host, ctx.couponCode, ctx.product]); // eslint-disable-line react-hooks/exhaustive-deps

  const audienceReady = audienceProblem(f.audience) === null;
  const preview = useAudiencePreview({ channel: f.channel, audience: f.audience }, audienceReady && !!store);
  const estimateInput: CampaignEstimateInput = {
    channel: f.channel,
    language: f.language,
    body: f.body,
    subject: f.channel === 'email' ? f.subject : null,
    audience: f.audience,
    coupon_id: f.coupon?.id ?? null,
    product_id: f.product?.id ?? null,
  };
  const estimate = useCampaignEstimate(estimateInput, audienceReady && !locked);
  const scheduledIso = f.sendMode === 'schedule' ? zonedToIso(f.date, f.time, tz) : null;
  const liveScheduleProblem = f.sendMode === 'schedule' ? scheduleProblem(scheduledIso, tz) : null;
  const smsLeft = allowanceLeft(allowanceOf(features.data, 'sms'));
  const emailLeft = allowanceLeft(allowanceOf(features.data, 'email'));
  const perPerson = f.channel === 'sms' ? Math.max(1, sms.count.parts) : 1;

  const applyApiError = (e: unknown) => {
    if (!isApiError(e)) return toast(errorMessage(e), 'error');
    if (e.code === 'revision_conflict') return setConflict(true);
    if (e.code === 'campaign_quiet_hours') return setScheduleError(quietHoursMessage());
    if (e.code === 'campaign_unknown_merge_field' || e.code === 'campaign_too_long' || e.code === 'campaign_coupon_inactive') return setErrors((x) => ({ ...x, body: e.message }));
    if (e.isValidation) {
      const next: FieldErrors = {};
      for (const k of ['name', 'subject', 'body', 'audience', 'scheduled_at']) {
        const m = e.fieldError(k) ?? (k === 'audience' ? e.fieldError('audience.params') : undefined);
        if (m) next[k] = m;
      }
      if (next.scheduled_at) setScheduleError(next.scheduled_at);
      if (Object.keys(next).length) return setErrors(next);
    }
    toast(e.message || errorMessage(e), 'error');
  };

  /** Create or PATCH; resolves to the stored campaign (or null after an error shown inline). */
  const persist = async (): Promise<Campaign | null> => {
    const input = toInput(f, tz);
    try {
      const row = await save.mutateAsync({ id: saved?.id ?? null, input: saved ? { ...input, revision: saved.revision } : input });
      setSaved(row);
      if (!saved) navigate(`/marketing/campaigns/${row.id}/edit`, { replace: true, state: { composerKey: 'new' } });
      return row;
    } catch (e) {
      applyApiError(e);
      return null;
    }
  };

  const check = (forSend: boolean): boolean => {
    const e = validateComposer(f, f.channel === 'sms' ? sms.count : null);
    if (!forSend) {
      // A draft may be incomplete; only block what the API would reject outright.
      delete e.audience;
      if (!f.body.trim()) delete e.body;
      if (!f.subject.trim()) delete e.subject;
    }
    setErrors(e);
    if (forSend && f.sendMode === 'schedule') {
      setScheduleError(liveScheduleProblem);
      if (liveScheduleProblem) return false;
    }
    return Object.keys(e).length === 0;
  };

  const onSaveDraft = async () => {
    if (!check(false)) return;
    const row = await persist();
    if (row) toast(row.status === 'scheduled' ? 'Changes saved.' : 'Draft saved.');
  };

  const onTest = async () => {
    if (!check(true)) return;
    const row = await persist();
    if (!row) return;
    test.mutate(row.id, {
      onSuccess: (r) => toast(`Test sent to ${r.to_masked}.`),
      onError: (e) => toast(isApiError(e) && e.status === 429 ? 'You’ve sent 5 tests this hour. Try again later.' : errorMessage(e), 'error'),
    });
  };

  const onLaunch = async () => {
    if (!check(true)) return;
    const row = await persist();
    if (!row) return;
    // Always confirm against numbers for exactly what is on screen (P85-QA-1).
    setConfirmEstimate(await fetchEstimate(estimateInput).catch(() => null));
    idemKey.current = newIdempotencyKey();
    setConfirming(true);
  };

  const confirmLaunch = () => {
    if (!saved) return;
    idemKey.current ??= newIdempotencyKey();
    launch.mutate(
      { id: saved.id, scheduledAt: f.sendMode === 'schedule' ? scheduledIso : null, idempotencyKey: idemKey.current },
      {
        onError: (e) => {
          // Retrying the same dialog reuses the key (contract §6.1); a validation-type answer closes it.
          if (isApiError(e) && e.status >= 400 && e.status < 500) {
            setConfirming(false);
            idemKey.current = null;
          }
          if (isApiError(e) && e.status === 402) toast('Not enough campaign allowance left this month. See your plan to send more.', 'error');
          else if (isApiError(e) && e.code === 'campaign_no_recipients') toast('Nobody in this audience can be messaged.', 'error');
          else if (isApiError(e) && e.code === 'store_not_live') toast('Publish your shop before sending campaigns.', 'error');
          else applyApiError(e);
        },
      },
    );
  };

  const recipients = estimate.data?.recipients ?? preview.data?.recipients ?? null;
  const shown = confirmEstimate ?? estimate.data;
  const confirmRecipients = shown?.recipients ?? recipients;
  const launchLabel = f.sendMode === 'now' ? 'Send campaign' : 'Schedule campaign';
  const totalMessages = shown?.total_parts ?? (confirmRecipients === null ? null : confirmRecipients * perPerson);
  const unit = f.channel === 'sms' ? 'SMS' : totalMessages === 1 ? 'email' : 'emails';

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <nav aria-label="Breadcrumb" className="text-caption font-medium text-text-muted">
            <Link to="/marketing" className="hover:text-text-primary">
              Marketing
            </Link>
            {'  /  '}
            <Link to="/marketing/campaigns" className="hover:text-text-primary">
              Campaigns
            </Link>
            {'  /  '}
            <span aria-current="page">{campaign ? 'Edit' : 'New'}</span>
          </nav>
          <h1 className="text-heading-24 text-text-primary">{campaign ? 'Edit campaign' : 'New campaign'}</h1>
          <p className="text-body text-text-secondary">Send a message to a segment. Bangla is fully supported.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void onSaveDraft()} loading={save.isPending && !confirming && !test.isPending} disabled={!editable}>
            Save draft
          </Button>
          <Button variant="secondary" onClick={() => void onTest()} loading={test.isPending} disabled={!editable || locked}>
            Send test to me
          </Button>
          <Button onClick={() => void onLaunch()} disabled={!editable || locked}>
            {launchLabel}
          </Button>
        </div>
      </div>
      {features.data && locked && <CampaignPlanNote canSeePlans={scope.canViewBilling} />}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <StepCard step={1} title="Channel">
            <Input label="Campaign name" value={f.name} maxLength={80} placeholder={defaultName(f)} error={errors.name} disabled={!editable} onChange={(e) => patch({ name: e.target.value })} />
            <div role="radiogroup" aria-label="Channel" className="grid gap-3 sm:grid-cols-2">
              <ChannelCard channel="sms" current={f.channel} left={smsLeft} disabled={!editable} onPick={(channel) => patch({ channel })} />
              <ChannelCard channel="email" current={f.channel} left={emailLeft} disabled={!editable} onPick={(channel) => patch({ channel })} />
            </div>
          </StepCard>

          <AudienceSection
            audience={f.audience}
            onChange={(audience) => patch({ audience })}
            preview={audienceReady ? preview.data : undefined}
            previewPending={preview.isFetching}
            previewError={preview.isError ? preview.error : null}
            error={errors.audience}
            disabled={!editable}
          />

          <MessageSection
            channel={f.channel}
            language={f.language}
            body={f.body}
            subject={f.subject}
            coupon={f.coupon}
            product={f.product}
            sms={sms}
            errors={errors}
            disabled={!editable}
            onLanguage={(language) => patch({ language })}
            onBody={(body) => patch({ body })}
            onSubject={(subject) => patch({ subject })}
            onCoupon={(coupon) => patch({ coupon })}
            onProduct={(product) => patch({ product })}
          />

          <StepCard step={4} title="When to send">
            <div role="radiogroup" aria-label="When to send" className="grid gap-3 sm:grid-cols-2">
              {(['now', 'schedule'] as const).map((m) => (
                <label
                  key={m}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-md border px-3.5 py-3 text-body font-medium text-text-primary has-[:focus-visible]:shadow-focus',
                    f.sendMode === m ? 'border-brand-500 bg-brand-50' : 'border-border-default bg-surface-card',
                  )}
                >
                  <input
                    type="radio"
                    name="send-mode"
                    value={m}
                    checked={f.sendMode === m}
                    disabled={!editable}
                    onChange={() => {
                      patch({ sendMode: m });
                      setScheduleError(null);
                    }}
                    className="size-5 shrink-0 accent-brand-600 outline-none"
                  />
                  {m === 'now' ? 'Send now' : 'Schedule'}
                </label>
              ))}
            </div>
            {f.sendMode === 'schedule' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Date" type="date" value={f.date} disabled={!editable} onChange={(e) => (patch({ date: e.target.value }), setScheduleError(null))} />
                <Input label={`Time (${tzLabel(tz)})`} type="time" value={f.time} disabled={!editable} onChange={(e) => (patch({ time: e.target.value }), setScheduleError(null))} />
              </div>
            )}
            {(scheduleError ?? (f.sendMode === 'schedule' ? liveScheduleProblem : null)) && (
              <p role="alert" className="flex items-center gap-2 rounded-md bg-danger-bg px-3 py-2.5 text-caption font-medium text-danger">
                <AlertTriangle aria-hidden className="size-4 shrink-0" />
                {scheduleError ?? liveScheduleProblem}
              </p>
            )}
            {f.sendMode === 'now' && <p className="text-caption text-text-muted">Campaigns only go out between 9 AM and 9 PM shop time.</p>}
          </StepCard>
        </div>

        <aside aria-label="Preview" className="flex w-full flex-col gap-4 lg:w-[360px] lg:shrink-0">
          <PhonePreview channel={f.channel} language={f.language} body={f.body} subject={f.subject} ctx={ctx} parts={sms.count.parts} />
          <AllowanceCard channel={f.channel} recipients={recipients} perPerson={perPerson} allowance={allowanceOf(features.data, f.channel)} estimate={estimate.data} canSeePlans={scope.canViewBilling} />
        </aside>
      </div>

      <Dialog
        open={confirming}
        title={f.sendMode === 'now' ? 'Send this campaign now?' : 'Schedule this campaign?'}
        description={
          f.sendMode === 'schedule' && scheduledIso
            ? `It goes out ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(scheduledIso))} shop time.`
            : 'Messages start going out in a minute.'
        }
        confirmLabel={launchLabel}
        loading={launch.isPending}
        onConfirm={confirmLaunch}
        onCancel={() => {
          setConfirming(false);
          idemKey.current = null;
        }}
      >
        <dl className="flex flex-col gap-2 text-body">
          <div className="flex gap-3">
            <dt className="flex-1 text-text-secondary">Recipients</dt>
            <dd className="font-medium text-text-primary">{confirmRecipients === null ? '—' : formatCount(confirmRecipients)} </dd>
          </div>
          <div className="flex gap-3">
            <dt className="flex-1 text-text-secondary">Total {f.channel === 'sms' ? 'SMS' : 'emails'}</dt>
            <dd className="font-medium text-text-primary">{totalMessages === null ? '—' : `${formatCount(totalMessages)} ${unit}`} </dd>
          </div>
          {shown && shown.allowance.remaining !== null && (
            <div className="flex gap-3">
              <dt className="flex-1 text-text-secondary">Left this month after</dt>
              <dd className="font-medium text-text-primary">{formatCount(Math.max(0, shown.allowance.after ?? 0))} </dd>
            </div>
          )}
        </dl>
        <p className="mt-3 text-caption text-text-muted">Customers who opted out are skipped automatically, even if they opt out after you schedule.</p>
      </Dialog>
      <ConflictDialog open={conflict} onReload={() => window.location.reload()} />
    </>
  );
}

function ChannelCard({ channel, current, left, disabled, onPick }: { channel: CampaignChannel; current: CampaignChannel; left: number | null; disabled?: boolean; onPick: (c: CampaignChannel) => void }) {
  const sms = channel === 'sms';
  return (
    <ChoiceCard
      name="channel"
      value={channel}
      checked={current === channel}
      disabled={disabled}
      onChange={() => onPick(channel)}
      title={sms ? 'SMS' : 'Email'}
      detail={sms ? 'Reaches every phone · Bangla & English' : 'Your logo + text · needs an email address'}
      aside={left === null ? null : `${formatCount(left)} left`}
    />
  );
}

export default CampaignComposerPage;
