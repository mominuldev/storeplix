import { isApiError } from '@storeplix/api-client';
import {
  AUTOMATION_LIMITS,
  RECIPE_PARAMS,
  type AutomationCondition,
  type AutomationConditionField,
  type AutomationDetail,
  type AutomationDryRun,
  type AutomationDryRunInput,
  type AutomationMessage,
  type AutomationSettings,
  type AutomationTrigger,
  type RecipeSchema,
} from '@storeplix/types';
import { Badge, Button, Chip, cn, Input, Menu, MoneyInput, Select, Skeleton, Toggle } from '@storeplix/ui';
import { Bell, Check, CheckCircle2, Clock, Mail, MessageCircle, Package, RotateCcw, ShieldCheck, ShoppingBag, Sparkles, Tag, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { formatBdt, formatCount, shortDate } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, StateCard } from '../catalog/states';
import { useCoupons, useOrders } from '../commerce/queries';
import { PageHeader } from '../layout/PageHeader';
import { toast } from '../online-store/components/Toast';
import { useFeatures } from '../plan/useFeatures';
import { useReturns } from '../returns/queries';
import {
  addableConditions,
  automationsLocked,
  conditionFieldLabels,
  conditionOpLabels,
  conditionProblem,
  defaultCondition,
  incompleteMessage,
  messageHead,
  messageProblem,
  ORDER_CHANNEL_CHIPS,
  previewText,
  RECOVERY_PATH,
  renderAutomationSms,
  selectedChannelChips,
  stepReasonLabels,
  toggleChannelChip,
} from './automations';
import { useAutomation, useAutomationTestMessage, useDryRun, useToggleAutomation, useUpdateAutomation } from './queries';
import { AutomationPlanNote, Card, Connector, ConnectorTag, FlowStep, IconBadge, MessageDialog, PausedPill } from './ui';

// Figma recipe editor 141:30622, PHASE-8-6 §10.2. Header (name, "Automations › Recipe · last edited by …", "Test with an
// order", "Save changes"); flow column When (trigger + order-channel chips for thank-you; Messenger / POS hidden) → If
// (the recipe's fixed condition list; "+ Add condition" limited to it; hidden for recipes without conditions) → Yes →
// Then (the recipe's actions in fixed order — no grip / drag / "+ Add action"; SMS preview + "Edit message" opening the
// 8.5 message editor with a 3-part counter) → Otherwise ("Nothing happens. The run is logged as skipped."). Side:
// Recipe settings (ON, Name, parameters), Test with an order (dry run), Last 7 days. Below `lg` the side cards stack
// under the flow (Q166). Checkout recovery has its own page (§10.3).

const TRIGGER_TITLE: Record<AutomationTrigger, string> = {
  'order.delivered': 'An order is delivered',
  'return.received': 'A returned parcel arrives',
  'stock.low': 'Stock drops below its low-stock level',
  'checkout.abandoned': 'Checkout started, not finished',
};
const TRIGGER_ICON: Record<AutomationTrigger, LucideIcon> = {
  'order.delivered': ShoppingBag,
  'return.received': RotateCcw,
  'stock.low': Package,
  'checkout.abandoned': ShoppingBag,
};
const DELAY_HOURS = [0, 1, 2, 6, 12, 24, 48, 72];

export function AutomationEditorPage() {
  const { automationId } = useParams();
  const q = useAutomation(automationId);
  if (q.data?.recipe === 'checkout_recovery') return <Navigate to={RECOVERY_PATH} replace />;
  if (q.isPending)
    return (
      <div role="status" aria-label="Loading automation" className="flex flex-col gap-6">
        <Skeleton className="h-14 w-80 max-w-full" />
        <div className="flex flex-col gap-6 lg:flex-row">
          <Skeleton className="h-[520px] flex-1 rounded-card" />
          <Skeleton className="h-[420px] rounded-card lg:w-[380px]" />
        </div>
      </div>
    );
  if (q.isError)
    return (
      <StateCard>
        <ErrorBlock title={isApiError(q.error) && q.error.status === 404 ? 'This automation doesn’t exist' : 'We couldn’t load this automation'} error={q.error} onRetry={() => void q.refetch()} />
      </StateCard>
    );
  return <Editor key={`${q.data.id}:${q.data.revision}`} automation={q.data} />;
}

type Draft = { name: string; settings: AutomationSettings };

function Editor({ automation }: { automation: AutomationDetail }) {
  const scope = useStoreScope();
  const features = useFeatures();
  const locked = automationsLocked(features.data);
  const update = useUpdateAutomation();
  const toggle = useToggleAutomation();
  const test = useAutomationTestMessage();
  const [draft, setDraft] = useState<Draft>(() => ({ name: automation.name, settings: structuredClone(automation.settings) }));
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const testRef = useRef<HTMLDivElement>(null);
  const dirty = draft.name !== automation.name || JSON.stringify(draft.settings) !== JSON.stringify(automation.settings);
  const schema = automation.recipe_schema;
  const tz = scope.store?.timezone ?? 'Asia/Dhaka';
  const coupons = useCoupons({ status: ['active'], per_page: 50 });
  const couponList = coupons.data?.data ?? [];

  const set = (patch: Partial<AutomationSettings>) => setDraft((d) => ({ ...d, settings: { ...d.settings, ...patch } as AutomationSettings }));
  const s = draft.settings as Partial<Record<string, unknown>>;
  const message = (s.message as (AutomationMessage & { enabled?: boolean }) | undefined) ?? null;
  const conditions = (s.conditions as AutomationCondition[] | undefined) ?? [];
  const couponId = (s.coupon_id as string | null | undefined) ?? null;
  const couponCode = couponList.find((c) => c.id === couponId)?.code ?? null;
  const shopName = scope.store?.name ?? 'Shop';
  const host = scope.store?.primary_domain ?? 'shop.storeplix.com';
  const sms = message ? renderAutomationSms(message.body, { language: message.language, shopName, host, couponCode }) : null;

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!draft.name.trim()) e.name = 'Give it a name.';
    if (message && (automation.recipe !== 'vip_tag' || message.enabled)) {
      const p = messageProblem(automation.recipe, message, message.channel === 'sms' ? (sms?.count.parts ?? null) : null, { couponRequired: automation.recipe === 'vip_tag', maxParts: schema.sms_max_parts });
      if (p) e.message = p;
    }
    conditions.forEach((c, i) => {
      const p = conditionProblem(c);
      if (p) e[`condition.${i}`] = p;
    });
    if (typeof s.tag === 'string' && !s.tag.trim()) e.tag = 'Type a tag.';
    return e;
  };

  const save = () => {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      toast('Check the highlighted fields.', 'error');
      return;
    }
    update.mutate(
      { id: automation.id, input: { name: draft.name.trim(), settings: draft.settings, revision: automation.revision } },
      {
        onSuccess: () => toast('Changes saved.'),
        onError: (err) => {
          if (isApiError(err) && err.code === 'revision_conflict') toast('Someone else changed this automation. We loaded the latest version — check and save again.', 'error');
          else if (isApiError(err) && err.status === 402) toast('Automations are part of the Starter plan.', 'error');
          else toast(errorMessage(err), 'error');
        },
      },
    );
  };

  const onToggle = (on: boolean) => {
    if (on && dirty) {
      toast('Save your changes first.', 'error');
      return;
    }
    toggle.mutate(
      { id: automation.id, on },
      {
        onSuccess: () => toast(on ? `“${automation.name}” is on.` : `“${automation.name}” is off. Nothing is deleted.`),
        onError: (err) => {
          if (isApiError(err) && err.code === 'automation_incomplete') toast(incompleteMessage(err.details as Record<string, unknown> | undefined), 'error');
          else if (isApiError(err) && err.status === 402) toast('Automations are part of the Starter plan.', 'error');
          else toast(errorMessage(err), 'error');
        },
      },
    );
  };

  // P86-22 / C12: one test message of the saved message step to the signed-in member.
  const sendTest = () =>
    test.mutate(
      { id: automation.id, step: 1 },
      {
        onSuccess: (r) => toast(dirty ? `Test of the saved message sent to ${r.to_masked}.` : `Test sent to ${r.to_masked}.`),
        onError: (err) =>
          toast(
            isApiError(err) && err.status === 429
              ? 'You can send 5 tests an hour. Try again later.'
              : isApiError(err) && err.code === 'plan_limit_reached'
                ? 'Not enough marketing messages left this month.'
                : isApiError(err) && err.status === 402
                  ? 'Automations are part of the Starter plan.'
                  : errorMessage(err),
            'error',
          ),
      },
    );

  const hasIf = automation.recipe === 'thank_you' || automation.recipe === 'vip_tag';
  const edited = automation.last_edited_by ? `last edited by ${automation.last_edited_by.name}, ${shortDate(automation.updated_at)}` : `last edited ${shortDate(automation.updated_at)}`;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {automation.name}
            {automation.paused_reason === 'plan' && <PausedPill />}
          </span>
        }
        subtitle={
          <span>
            Automations <span aria-hidden>›</span> Recipe · {edited}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => testRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
              Test with an order
            </Button>
            <Button onClick={save} loading={update.isPending} disabled={!dirty}>
              Save changes
            </Button>
          </>
        }
      />
      {features.data && locked && <AutomationPlanNote canSeePlans={scope.canViewBilling} />}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col items-center">
          <FlowStep icon={TRIGGER_ICON[schema.trigger]} tone="info" eyebrow="When" title={TRIGGER_TITLE[schema.trigger]}>
            <p className="text-body text-text-secondary">{schema.trigger_description}</p>
            {schema.allowed_conditions.includes('order.channel') && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Order channels">
                {ORDER_CHANNEL_CHIPS.map((c) => {
                  const on = selectedChannelChips(conditions).has(c.label);
                  return (
                    <Chip key={c.label} check={false} selected={on} aria-pressed={on} onClick={() => set({ conditions: toggleChannelChip(conditions, c.label) } as Partial<AutomationSettings>)}>
                      {c.label}
                    </Chip>
                  );
                })}
              </div>
            )}
          </FlowStep>
          <Connector />
          {hasIf && (
            <>
              <FlowStep icon={ShieldCheck} tone="warning" eyebrow="If" title={automation.recipe === 'vip_tag' ? 'The buyer is a regular' : 'These all hold'}>
                <p className="text-body text-text-secondary">All of these must be true. Checked when the run starts.</p>
                {automation.recipe === 'vip_tag' ? (
                  <VipConditions minDelivered={s.min_delivered as number} tag={s.tag as string} onMin={(n) => set({ min_delivered: n } as Partial<AutomationSettings>)} />
                ) : (
                  <ConditionList
                    schema={schema}
                    conditions={conditions}
                    errors={errors}
                    onChange={(next) => set({ conditions: next } as Partial<AutomationSettings>)}
                  />
                )}
              </FlowStep>
              <Connector>
                <ConnectorTag>Yes</ConnectorTag>
              </Connector>
            </>
          )}
          <FlowStep icon={Sparkles} tone="brand" eyebrow="Then" title="Do these, in order">
            {schema.steps.map((st, i) => (
              <ActionRow key={i} kind={st.kind} title={st.title} description={st.description} trailing={actionTrailing(st.kind)}>
                {st.kind === 'send_message' && message && (
                  <SmsPreview
                    message={message}
                    parts={sms?.count.parts ?? 0}
                    text={previewText(message.body, { host, couponCode, language: message.language })}
                    error={errors.message}
                    disabled={automation.recipe === 'vip_tag' && !message.enabled}
                    onEdit={() => setEditing(true)}
                    onTest={locked ? undefined : sendTest}
                    testing={test.isPending}
                  />
                )}
              </ActionRow>
            ))}
            {automation.recipe === 'return_flag' && <p className="text-caption text-text-muted">Restock stays in Returns: you choose per line when the parcel is checked.</p>}
          </FlowStep>
          {hasIf && (
            <>
              <Connector>
                <ConnectorTag>Otherwise</ConnectorTag>
              </Connector>
              <FlowStep icon={Check} tone="success" eyebrow="Otherwise" title="Nothing happens">
                <p className="text-body text-text-secondary">Nothing happens. The run is logged as skipped.</p>
              </FlowStep>
            </>
          )}
        </div>

        <div className="flex w-full flex-col gap-6 lg:w-[380px] lg:shrink-0">
          <Card
            title="Recipe settings"
            className="gap-4"
            action={<Toggle label="Automation on" checked={automation.status === 'on'} disabled={toggle.isPending || (locked && automation.status !== 'on')} onChange={onToggle} />}
          >
            <Input label="Name" value={draft.name} maxLength={AUTOMATION_LIMITS.name_max} error={errors.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            {typeof s.tag === 'string' && (
              <Input label="Tag" value={s.tag} maxLength={AUTOMATION_LIMITS.tag_max} error={errors.tag} hint="Added to the customer. Up to 20 tags per customer." onChange={(e) => set({ tag: e.target.value } as Partial<AutomationSettings>)} />
            )}
            {automation.recipe === 'vip_tag' && (
              <Select
                label="Coupon in the message"
                value={couponId ?? ''}
                hint={message?.enabled ? 'Required to switch this on. Only active coupons.' : 'Only used when the message is on.'}
                onChange={(e) => set({ coupon_id: e.target.value || null } as Partial<AutomationSettings>)}
              >
                <option value="">{coupons.isPending ? 'Loading coupons…' : 'No coupon'}</option>
                {couponList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}
                  </option>
                ))}
              </Select>
            )}
            {automation.recipe === 'low_stock' && (
              <Note icon={Mail}>Emails go to owners, managers and team members who can adjust inventory. No customer is messaged.</Note>
            )}
            {message && <Note icon={Clock}>Quiet hours 9 PM – 9 AM: messages wait until morning. Max 2 automated messages per customer a day.</Note>}
          </Card>
          <div ref={testRef}>
            <TestCard automation={automation} tz={tz} />
          </div>
          <LastSevenDays automation={automation} />
        </div>
      </div>

      {message && editing && (
        <MessageDialog
          open
          title="Edit message"
          recipe={automation.recipe}
          message={message}
          couponCode={couponCode}
          couponRequired={automation.recipe === 'vip_tag'}
          mergeFields={schema.merge_fields}
          maxParts={schema.sms_max_parts}
          onClose={() => setEditing(false)}
          onApply={(m) => {
            set({ message: { ...message, ...m } } as Partial<AutomationSettings>);
            setErrors(({ message: _m, ...rest }) => rest);
            setEditing(false);
          }}
        />
      )}
    </>
  );

  function actionTrailing(kind: RecipeSchema['steps'][number]['kind']): ReactNode {
    if (kind === 'wait' && automation.recipe === 'thank_you') {
      const h = s.delay_hours as number;
      return (
        <select
          aria-label="Send after"
          value={String(h)}
          onChange={(e) => set({ delay_hours: Number(e.target.value) } as Partial<AutomationSettings>)}
          className="rounded-lg border border-border-default bg-surface-card py-2 pr-2 pl-3 text-body font-medium text-text-primary outline-none focus-visible:shadow-focus"
        >
          {DELAY_HOURS.filter((n) => n >= RECIPE_PARAMS.thank_you.delay_hours.min && n <= RECIPE_PARAMS.thank_you.delay_hours.max).map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'Right away' : `${n} h`}
            </option>
          ))}
        </select>
      );
    }
    if (kind === 'send_message' && automation.recipe === 'vip_tag' && message) {
      return <Toggle label="Send the message" checked={!!message.enabled} onChange={(on) => set({ message: { ...message, enabled: on } } as Partial<AutomationSettings>)} />;
    }
    if (kind === 'add_tag' && typeof s.tag === 'string' && s.tag.trim()) {
      return (
        <Badge size="sm" tone="brand">
          {s.tag}
        </Badge>
      );
    }
    return null;
  }
}

const KIND_ICON: Record<RecipeSchema['steps'][number]['kind'], LucideIcon> = { send_message: MessageCircle, add_tag: Tag, notify_team: Bell, wait: Clock };

function ActionRow({ kind, title, description, trailing, children }: { kind: RecipeSchema['steps'][number]['kind']; title: string; description: string; trailing?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-default p-3 sm:flex-nowrap">
        <IconBadge icon={KIND_ICON[kind]} tone="brand" size={32} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-body font-medium text-text-primary">{title}</p>
          <p className="text-caption text-text-secondary">{description}</p>
        </div>
        {trailing}
      </div>
      {children}
    </div>
  );
}

/** SMS preview block (141:31307): "SMS · Bangla · 2 parts" + "Edit message", the body with sample values. */
function SmsPreview({ message, parts, text, error, disabled, onEdit, onTest, testing }: { message: AutomationMessage; parts: number; text: string; error?: string; disabled?: boolean; onEdit: () => void; onTest?: () => void; testing?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-lg bg-brand-50 px-3.5 py-3', disabled && 'opacity-60', error && 'ring-1 ring-danger')}>
      <div className="flex items-center gap-2">
        <p className="text-caption font-medium text-brand-600" data-testid="message-head">
          {messageHead(message, parts)}
        </p>
        <span className="flex-1" />
        {onTest && (
          <button type="button" onClick={onTest} disabled={testing} className="rounded-sm text-caption font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus disabled:opacity-50">
            {testing ? 'Sending…' : 'Send test'}
          </button>
        )}
        <button type="button" onClick={onEdit} className="rounded-sm text-caption font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
          Edit message
        </button>
      </div>
      {message.channel === 'email' && message.subject && <p className="text-body font-medium text-text-primary">{message.subject}</p>}
      <p className={cn('text-body leading-[22px] whitespace-pre-line text-text-primary', message.language === 'bn' && 'font-bangla')}>{text || 'No message yet.'}</p>
      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Condition row (141:31247): white tokens on surface-subtle, trash on the right. */
function ConditionRow({ lead, children, onRemove, error }: { lead?: string; children: ReactNode; onRemove?: () => void; error?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-surface-subtle px-2.5 py-2">
        {lead && (
          <Badge size="sm" tone="neutral">
            {lead}
          </Badge>
        )}
        {children}
        <span className="flex-1" />
        {onRemove && (
          <button type="button" aria-label="Remove condition" onClick={onRemove} className="rounded-sm p-1 text-text-muted outline-none hover:text-text-primary focus-visible:shadow-focus">
            <Trash2 aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {error && <p className="text-caption text-danger">{error}</p>}
    </div>
  );
}

const tokenCls = 'rounded-lg border border-border-default bg-surface-card px-2.5 py-1.5 text-body';

function Token({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <span className={cn(tokenCls, muted ? 'text-text-secondary' : 'font-medium text-text-primary')}>{children}</span>;
}

function ConditionList({ schema, conditions, errors, onChange }: { schema: RecipeSchema; conditions: AutomationCondition[]; errors: Record<string, string>; onChange: (c: AutomationCondition[]) => void }) {
  const rows = conditions.map((c, i) => ({ c, i })).filter(({ c }) => c.field !== 'order.channel');
  const addable = addableConditions(schema.allowed_conditions, conditions, schema.max_conditions);
  const replace = (i: number, next: AutomationCondition) => onChange(conditions.map((c, j) => (j === i ? next : c)));
  return (
    <>
      {rows.length === 0 && <p className="rounded-[10px] bg-surface-subtle px-3 py-2.5 text-body text-text-secondary">No conditions: every delivered order gets the message.</p>}
      {rows.map(({ c, i }, n) => (
        <ConditionRow key={`${c.field}-${i}`} lead={n > 0 ? 'AND' : undefined} onRemove={() => onChange(conditions.filter((_, j) => j !== i))} error={errors[`condition.${i}`]}>
          <Token>{conditionFieldLabels[c.field]}</Token>
          {c.field === 'order.total_amount' && (
            <>
              <select aria-label="Comparison" value={c.op} onChange={(e) => replace(i, { ...c, op: e.target.value as 'gt' | 'lt' })} className={cn(tokenCls, 'text-text-secondary')}>
                <option value="gt">{conditionOpLabels.gt}</option>
                <option value="lt">{conditionOpLabels.lt}</option>
              </select>
              <MoneyInput aria-label="Amount" value={c.value} onChange={(v) => replace(i, { ...c, value: v ?? 0 })} className="h-9 w-32" />
            </>
          )}
          {c.field === 'order.payment_method' && (
            <>
              <Token muted>{conditionOpLabels.is}</Token>
              <select aria-label="Payment method" value={c.value} onChange={(e) => replace(i, { ...c, value: e.target.value as 'cod' | 'online' })} className={cn(tokenCls, 'font-medium text-text-primary')}>
                <option value="cod">Cash on delivery</option>
                <option value="online">Paid online</option>
              </select>
            </>
          )}
          {c.field === 'customer.tag' && (
            <>
              <select aria-label="Has or doesn’t have" value={c.op} onChange={(e) => replace(i, { ...c, op: e.target.value as 'has' | 'not_has' })} className={cn(tokenCls, 'text-text-secondary')}>
                <option value="has">{conditionOpLabels.has}</option>
                <option value="not_has">{conditionOpLabels.not_has}</option>
              </select>
              <input aria-label="Tag" value={c.value} maxLength={AUTOMATION_LIMITS.tag_max} placeholder="Tag" onChange={(e) => replace(i, { ...c, value: e.target.value })} className={cn(tokenCls, 'w-32 font-medium text-text-primary outline-none focus-visible:shadow-focus')} />
            </>
          )}
        </ConditionRow>
      ))}
      {addable.length > 0 && (
        <Menu
          label="Add condition"
          align="start"
          trigger={<span>+ Add condition</span>}
          triggerClassName="h-8 w-full justify-center px-3 text-caption font-medium text-brand-600 hover:bg-brand-50"
          entries={addable.map((f: AutomationConditionField) => ({ key: f, label: conditionFieldLabels[f], onSelect: () => onChange([...conditions, defaultCondition(f)]) }))}
          className="w-[220px]"
        />
      )}
    </>
  );
}

function VipConditions({ minDelivered, tag, onMin }: { minDelivered: number; tag: string; onMin: (n: number) => void }) {
  const b = RECIPE_PARAMS.vip_tag.min_delivered;
  return (
    <>
      <ConditionRow>
        <Token>{conditionFieldLabels['customer.delivered_orders_count']}</Token>
        <Token muted>{conditionOpLabels.gte}</Token>
        <input
          type="number"
          aria-label="Delivered orders"
          min={b.min}
          max={b.max}
          value={minDelivered}
          onChange={(e) => onMin(Math.max(b.min, Math.min(b.max, Number(e.target.value) || b.min)))}
          className={cn(tokenCls, 'w-20 font-medium text-text-primary outline-none focus-visible:shadow-focus')}
        />
      </ConditionRow>
      <ConditionRow lead="AND">
        <Token>Customer</Token>
        <Token muted>doesn’t have tag</Token>
        <Token>{tag || '—'}</Token>
      </ConditionRow>
    </>
  );
}

function Note({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-surface-subtle px-3 py-2.5">
      <Icon aria-hidden className="mt-px size-4 shrink-0 text-text-muted" />
      <p className="min-w-0 flex-1 text-caption text-text-secondary">{children}</p>
    </div>
  );
}

/** "Test with an order" (141:31433): subject picker + dry-run results (check / cross, rendered message). P86-21. */
function TestCard({ automation, tz }: { automation: AutomationDetail; tz: string }) {
  const dry = useDryRun();
  const [subject, setSubject] = useState('');
  const trigger = automation.recipe_schema.trigger;
  const orders = useOrders({ status: ['delivered'], sort: '-placed_at', per_page: 10 }, trigger === 'order.delivered');
  const returns = useReturns({ sort: '-created_at', per_page: 10 } as Parameters<typeof useReturns>[0]);
  const options = useMemo(() => {
    if (trigger === 'order.delivered') return (orders.data?.data ?? []).map((o) => ({ value: o.id, label: `${o.number} · ${o.customer.name ?? 'Customer'} · ${formatBdt(o.total_amount)}` }));
    if (trigger === 'return.received') return (returns.data?.data ?? []).map((r) => ({ value: r.id, label: `${r.number} · ${r.customer.name} · order ${r.order.number}` }));
    return [];
  }, [trigger, orders.data, returns.data]);
  const noun = trigger === 'order.delivered' ? 'Order' : trigger === 'return.received' ? 'Return' : 'Product';
  const latest = trigger === 'order.delivered' ? 'Latest delivered order' : trigger === 'return.received' ? 'Latest return' : 'Latest low-stock product';

  const run = () => {
    const input: AutomationDryRunInput = !subject ? {} : trigger === 'order.delivered' ? { order_id: subject } : trigger === 'return.received' ? { return_id: subject } : {};
    dry.mutate({ id: automation.id, input });
  };
  useEffect(() => {
    dry.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clear the old result when the subject changes
  }, [subject]);

  return (
    <Card title={automation.recipe_schema.trigger === 'stock.low' ? 'Test with a product' : `Test with ${noun === 'Order' ? 'an order' : 'a return'}`} subtitle="Dry run — nothing is sent or changed." className="gap-3">
      <Select label={noun} value={subject} onChange={(e) => setSubject(e.target.value)}>
        <option value="">{latest}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      <Button variant="secondary" onClick={run} loading={dry.isPending}>
        Run test
      </Button>
      {dry.isError && <p role="alert" className="text-caption text-danger">{isApiError(dry.error) && dry.error.status === 429 ? 'Too many tests. Wait a minute and try again.' : errorMessage(dry.error)}</p>}
      {dry.data && <DryRunResults result={dry.data} tz={tz} />}
    </Card>
  );
}

function ResultLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[10px]', ok ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger')}>
        {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      </span>
      <span className="sr-only">{ok ? 'Passes:' : 'Fails:'}</span>
      <div className="min-w-0 flex-1 text-body text-text-primary">{children}</div>
    </li>
  );
}

const WOULD: Record<AutomationDryRun['steps'][number]['would'], string> = { send: 'Would send', skip: 'Would skip', tag: 'Would tag', notify: 'Would email the team' };

export function DryRunResults({ result }: { result: AutomationDryRun; tz?: string }) {
  if (!result.subject) return <p className="text-body text-text-secondary">Nothing to test with yet. It works once your shop has a matching order.</p>;
  return (
    <ul aria-label="Test results" className="flex flex-col gap-2.5">
      <li className="text-caption text-text-muted">Tested with {result.subject.label}</li>
      {result.conditions.map((c, i) => (
        <ResultLine key={`c${i}`} ok={c.passed}>
          {c.label}
          {c.detail && <span className="text-text-secondary"> ({c.detail})</span>}
        </ResultLine>
      ))}
      {result.steps.map((st) => (
        <ResultLine key={`s${st.index}`} ok={st.would !== 'skip'}>
          {WOULD[st.would]}
          {st.reason && <span className="text-text-secondary"> · {stepReasonLabels[st.reason]}</span>}
          {st.rendered && (
            <span className="mt-1.5 block rounded-lg bg-surface-subtle px-3 py-2 text-caption whitespace-pre-line text-text-secondary">
              {st.rendered.subject && <span className="block font-medium text-text-primary">{st.rendered.subject}</span>}
              {st.rendered.text}
              {st.rendered.channel === 'sms' && <span className="mt-1 block text-text-muted">{st.rendered.parts} SMS</span>}
            </span>
          )}
        </ResultLine>
      ))}
    </ul>
  );
}

/** "Last 7 days" (141:31459): summary line from `stats_7d`, outcome bar, legend pills. */
function LastSevenDays({ automation }: { automation: AutomationDetail }) {
  const st = automation.stats_7d;
  const segs = [
    { key: 'completed', label: 'Completed', value: st.completed, bar: 'bg-success', tone: 'success' as const },
    { key: 'skipped', label: 'Skipped', value: st.skipped, bar: 'bg-border-strong', tone: 'neutral' as const },
    { key: 'stopped', label: 'Stopped', value: st.stopped, bar: 'bg-warning', tone: 'warning' as const },
    { key: 'failed', label: 'Failed', value: st.failed, bar: 'bg-danger', tone: 'danger' as const },
  ].filter((x) => x.value > 0);
  const total = segs.reduce((a, b) => a + b.value, 0);
  return (
    <Card
      title="Last 7 days"
      subtitle={st.runs === 0 ? 'No runs yet' : `${formatCount(st.runs)} runs · ${formatCount(st.completed)} completed · ${formatCount(st.skipped)} skipped`}
      className="gap-1"
    >
      {total > 0 && (
        <>
          <div aria-hidden className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-subtle">
            {segs.map((x) => (
              <span key={x.key} className={x.bar} style={{ width: `${(x.value / total) * 100}%` }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            {segs.map((x) => (
              <Badge key={x.key} tone={x.tone} dot>
                {x.label} · {Math.round((x.value / total) * 100)}%
              </Badge>
            ))}
          </div>
        </>
      )}
      {automation.status === 'on' && total === 0 && (
        <p className="flex items-center gap-2 pt-2 text-caption text-text-muted">
          <CheckCircle2 aria-hidden className="size-4" /> On and waiting for the next trigger.
        </p>
      )}
    </Card>
  );
}

export default AutomationEditorPage;
