import type { InboxExternalChannel, InboxReplyTime, InboxSettings, UpdateInboxSettingsInput } from '@storeplix/types';
import { INBOX_REPLY_TIME_LABELS } from '@storeplix/types';
import { Badge, Button, buttonVariants, cn, copyText, Dialog, Drawer, Input, Select, Skeleton, Toggle } from '@storeplix/ui';
import { Camera, Copy, ExternalLink, Mail, MessageCircle, MessagesSquare, Phone, RefreshCw, ShieldCheck, ShoppingBag, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { ErrorBlock } from '../catalog/states';
import { toast } from '../online-store/components/Toast';
import { inboxErrorText } from './errors';
import { useInboxSettings, useRotateEmailAddress, useUpdateInboxSettings } from './queries';

// PHASE-8-8E §4, §18: "Connect a channel" drawer — our three channels with switches (`settings.manage`), the inbound
// email address with Copy + Rotate, widget reply time / hours / greeting; Messenger, WhatsApp and Instagram as
// "Coming later" cards (8.8f). First-run card 2123:52602 shows each channel with Off + Turn on until enabled (Q303).

type ChannelKey = 'web_chat' | 'order_messages' | 'email';
const FIELD: Record<ChannelKey, 'web_chat_enabled' | 'order_messages_enabled' | 'email_enabled'> = {
  web_chat: 'web_chat_enabled',
  order_messages: 'order_messages_enabled',
  email: 'email_enabled',
};
const EXTERNAL: Record<InboxExternalChannel, { label: string; icon: LucideIcon }> = {
  messenger: { label: 'Facebook Messenger', icon: MessagesSquare },
  whatsapp: { label: 'WhatsApp', icon: Phone },
  instagram: { label: 'Instagram', icon: Camera },
};

export const CHANNEL_COPY: Record<ChannelKey, { title: string; text: string; icon: LucideIcon }> = {
  web_chat: { title: 'Website chat', text: 'A chat button on every page of your shop. Customers can send photos and PDFs.', icon: MessageCircle },
  order_messages: { title: 'Order messages', text: 'Customers message you from their order page. The order is linked for you.', icon: ShoppingBag },
  email: { title: 'Email replies', text: 'Replies to your order emails land here, threaded with the order.', icon: Mail },
};

/** Toggle one channel with the current revision; returns a handler for switches and "Turn on" buttons. */
export function useChannelSwitch(settings: InboxSettings | undefined) {
  const update = useUpdateInboxSettings();
  const run = (input: Omit<UpdateInboxSettingsInput, 'revision'>, done?: string) => {
    if (!settings) return;
    update.mutate({ ...input, revision: settings.revision }, { onSuccess: () => done && toast(done), onError: (e) => toast(inboxErrorText(e), 'error') });
  };
  return {
    pending: update.isPending,
    set: (key: ChannelKey, on: boolean) => run({ [FIELD[key]]: on }, `${CHANNEL_COPY[key].title} turned ${on ? 'on' : 'off'}.`),
    save: (input: Omit<UpdateInboxSettingsInput, 'revision'>) => run(input, 'Chat widget saved.'),
  };
}

function copyAddress(address: string) {
  void copyText(address).then(
    () => toast('Address copied.'),
    () => toast('Couldn’t copy. Select the address and copy it.', 'error'),
  );
}

export function ChannelsDrawer({ open, onClose, readOnly }: { open: boolean; onClose: () => void; readOnly: boolean }) {
  const settings = useInboxSettings(open);
  const s = settings.data;
  const sw = useChannelSwitch(s);
  const rotate = useRotateEmailAddress();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const editable = !!s?.can.edit && !readOnly;

  return (
    <Drawer open={open} onClose={onClose} title="Channels" description="Where customers can message you." width={440}>
      <div className="p-4">
      {settings.isPending ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading channels">
          <Skeleton className="h-28 rounded-card" />
          <Skeleton className="h-28 rounded-card" />
          <Skeleton className="h-28 rounded-card" />
        </div>
      ) : settings.isError || !s ? (
        <ErrorBlock title="We couldn’t load your channels" error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {!editable && (
            <p className="rounded-lg bg-surface-subtle px-3 py-2 text-caption text-text-secondary">
              {readOnly ? 'Read-only support session.' : 'Only members who can change shop settings can switch channels.'}
            </p>
          )}
          <ChannelCard
            k="web_chat"
            on={s.channels.web_chat.enabled}
            editable={editable}
            busy={sw.pending}
            onToggle={(v) => sw.set('web_chat', v)}
            footer={
              s.channels.web_chat.enabled && s.channels.web_chat.live_on ? (
                <a href={`https://${s.channels.web_chat.live_on}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-caption font-medium text-brand-600 hover:underline">
                  Live on {s.channels.web_chat.live_on} <ExternalLink aria-hidden className="size-3.5" />
                </a>
              ) : null
            }
          >
            {s.channels.web_chat.enabled && <WidgetForm key={s.revision} settings={s} editable={editable} busy={sw.pending} onSave={sw.save} />}
          </ChannelCard>
          <ChannelCard
            k="order_messages"
            on={s.channels.order_messages.enabled}
            editable={editable}
            busy={sw.pending}
            onToggle={(v) => sw.set('order_messages', v)}
            footer={s.channels.order_messages.enabled ? <span className="text-caption text-text-muted">On for every order (tracking and thank-you pages)</span> : null}
          />
          <ChannelCard
            k="email"
            on={s.channels.email.enabled}
            editable={editable && (s.channels.email.available || s.channels.email.enabled)}
            busy={sw.pending}
            onToggle={(v) => sw.set('email', v)}
            footer={
              !s.channels.email.available ? (
                <span className="text-caption text-text-muted">Not available yet — inbound email isn’t set up on Store Plix.</span>
              ) : s.channels.email.address ? (
                <div className="flex flex-col gap-2">
                  <span className="text-caption text-text-secondary">Forwarding address</span>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-surface-subtle px-2.5 py-1.5 text-caption text-text-primary">{s.channels.email.address}</code>
                    <Button size="sm" variant="secondary" leftIcon={<Copy aria-hidden className="size-3.5" />} onClick={() => copyAddress(s.channels.email.address!)}>
                      Copy
                    </Button>
                  </div>
                  {editable && (
                    <button type="button" onClick={() => setConfirmRotate(true)} className="inline-flex items-center gap-1 self-start text-caption font-medium text-brand-600 hover:underline">
                      <RefreshCw aria-hidden className="size-3.5" /> Get a new address
                    </button>
                  )}
                </div>
              ) : null
            }
          />

          <section aria-label="Coming later" className="flex flex-col gap-2 pt-2">
            <h3 className="text-body font-semibold text-text-primary">More channels</h3>
            {s.external_channels.map((e) => {
              const meta = EXTERNAL[e.channel];
              const Icon = meta.icon;
              return (
                <div key={e.channel} className="flex items-center gap-3 rounded-lg border border-border-default bg-surface-subtle px-3 py-2.5">
                  <Icon aria-hidden className="size-[18px] text-text-secondary" />
                  <span className="flex-1 text-body text-text-secondary">{meta.label}</span>
                  <Badge size="sm">Coming later</Badge>
                </div>
              );
            })}
          </section>
        </div>
      )}
      <Dialog
        open={confirmRotate}
        title="Get a new email address?"
        description="The current address stops working right away. Replies to emails you already sent keep reaching this Inbox."
        confirmLabel="Get a new address"
        loading={rotate.isPending}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={() =>
          rotate.mutate(undefined, {
            onSuccess: () => {
              setConfirmRotate(false);
              toast('New address ready.');
            },
            onError: (e) => toast(inboxErrorText(e), 'error'),
          })
        }
      />
      </div>
    </Drawer>
  );
}

function ChannelCard({
  k,
  on,
  editable,
  busy,
  onToggle,
  footer,
  children,
}: {
  k: ChannelKey;
  on: boolean;
  editable: boolean;
  busy: boolean;
  onToggle: (v: boolean) => void;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const copy = CHANNEL_COPY[k];
  const Icon = copy.icon;
  return (
    <section aria-label={copy.title} className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Icon aria-hidden className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-body font-semibold text-text-primary">{copy.title}</h3>
          <p className="text-caption text-text-secondary">{copy.text}</p>
        </div>
        <Toggle checked={on} disabled={!editable || busy} onChange={onToggle} label={copy.title} />
      </div>
      {footer}
      {children}
    </section>
  );
}

function WidgetForm({ settings, editable, busy, onSave }: { settings: InboxSettings; editable: boolean; busy: boolean; onSave: (v: { widget_reply_time: InboxReplyTime; widget_hours: string | null; widget_greeting: string | null }) => void }) {
  const [replyTime, setReplyTime] = useState<InboxReplyTime>(settings.widget.reply_time);
  const [hours, setHours] = useState(settings.widget.hours ?? '');
  const [greeting, setGreeting] = useState(settings.widget.greeting ?? '');
  const dirty = replyTime !== settings.widget.reply_time || hours !== (settings.widget.hours ?? '') || greeting !== (settings.widget.greeting ?? '');
  return (
    <form
      className="flex flex-col gap-3 border-t border-border-default pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ widget_reply_time: replyTime, widget_hours: hours.trim() || null, widget_greeting: greeting.trim() || null });
      }}
    >
      <label className="flex flex-col gap-1.5 text-caption font-medium text-text-secondary">
        Reply time shown to customers
        <Select value={replyTime} disabled={!editable} onChange={(e) => setReplyTime(e.target.value as InboxReplyTime)}>
          {(Object.keys(INBOX_REPLY_TIME_LABELS) as InboxReplyTime[]).map((t) => (
            <option key={t} value={t}>
              {INBOX_REPLY_TIME_LABELS[t]}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex flex-col gap-1.5 text-caption font-medium text-text-secondary">
        Hours (optional)
        <Input value={hours} maxLength={40} disabled={!editable} placeholder="10am – 10pm" onChange={(e) => setHours(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5 text-caption font-medium text-text-secondary">
        Greeting (optional)
        <textarea
          value={greeting}
          maxLength={200}
          rows={2}
          disabled={!editable}
          placeholder="Hi! Ask us about sizes, delivery or anything else."
          onChange={(e) => setGreeting(e.target.value)}
          className="rounded-md border border-border-default bg-surface-card px-3 py-2 text-body font-normal text-text-primary outline-none focus:shadow-focus disabled:bg-surface-subtle"
        />
      </label>
      {editable && (
        <Button type="submit" size="sm" variant="secondary" disabled={!dirty} loading={busy} className="self-start">
          Save chat widget
        </Button>
      )}
    </form>
  );
}

/** First-run 2123:52602: "No conversations yet" with the three channel cards (Off + Turn on until enabled). */
export function FirstRun({ readOnly, canEdit, onOpenChannels }: { readOnly: boolean; canEdit: boolean; onOpenChannels: () => void }) {
  const settings = useInboxSettings();
  const s = settings.data;
  const sw = useChannelSwitch(s);
  const editable = canEdit && !readOnly && !!s?.can.edit;
  const anyOn = !!s && (s.channels.web_chat.enabled || s.channels.order_messages.enabled || s.channels.email.enabled);
  const host = s?.channels.web_chat.live_on ?? null;

  const card = (k: ChannelKey, on: boolean, meta: React.ReactNode, action: React.ReactNode) => {
    const copy = CHANNEL_COPY[k];
    const Icon = copy.icon;
    return (
      <div className="flex flex-1 flex-col gap-2 rounded-card border border-border-default bg-surface-card p-4 text-left">
        <div className="flex items-start justify-between">
          <span className="flex size-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Icon aria-hidden className="size-[18px]" />
          </span>
          <Badge tone={on ? 'success' : 'neutral'} size="sm">
            {on ? 'On' : 'Off'}
          </Badge>
        </div>
        <h3 className="text-body-lg font-medium text-text-primary">{copy.title}</h3>
        <p className="flex-1 text-body text-text-secondary">{copy.text}</p>
        {meta && <p className="truncate text-caption text-text-muted">{meta}</p>}
        {action}
      </div>
    );
  };
  const turnOn = (k: ChannelKey, disabled = false) =>
    editable ? (
      <Button variant="secondary" size="sm" fullWidth disabled={disabled} loading={sw.pending} onClick={() => sw.set(k, true)}>
        Turn on
      </Button>
    ) : (
      <p className="text-caption text-text-muted">{readOnly ? 'Read-only support session' : 'Ask an owner or manager to turn this on.'}</p>
    );

  return (
    <section aria-label="Inbox" className="flex flex-1 flex-col items-center justify-center gap-6 rounded-card border border-border-default bg-surface-card px-4 py-12 shadow-elevation-1 sm:px-10">
      <span className="flex size-14 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <MessageCircle aria-hidden className="size-6" />
      </span>
      <div className="flex max-w-md flex-col gap-1.5 text-center">
        <h2 className="text-heading text-text-primary">No conversations yet</h2>
        <p className="text-body text-text-secondary">
          {anyOn
            ? 'When a customer writes from your shop, from an order page or replies to an order email, it lands here.'
            : 'Turn on a channel so customers can reach you. Everything they send lands here.'}
        </p>
      </div>
      {settings.isPending ? (
        <div className="grid w-full max-w-4xl gap-3 sm:grid-cols-3">
          <Skeleton className="h-48 rounded-card" />
          <Skeleton className="h-48 rounded-card" />
          <Skeleton className="h-48 rounded-card" />
        </div>
      ) : settings.isError || !s ? (
        <ErrorBlock title="We couldn’t load your channels" error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <div className="grid w-full max-w-4xl gap-3 sm:grid-cols-3">
          {card(
            'web_chat',
            s.channels.web_chat.enabled,
            s.channels.web_chat.enabled && host ? `Live on ${host}` : null,
            s.channels.web_chat.enabled ? (
              host ? (
                <a href={`https://${host}`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'secondary', size: 'sm', fullWidth: true })}>
                  Preview on your shop
                </a>
              ) : null
            ) : (
              turnOn('web_chat')
            ),
          )}
          {card(
            'order_messages',
            s.channels.order_messages.enabled,
            s.channels.order_messages.enabled ? 'On for every order' : null,
            s.channels.order_messages.enabled ? (
              host ? (
                <a href={`https://${host}/track`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'secondary', size: 'sm', fullWidth: true })}>
                  See an example
                </a>
              ) : null
            ) : (
              turnOn('order_messages')
            ),
          )}
          {card(
            'email',
            s.channels.email.enabled,
            s.channels.email.enabled && s.channels.email.address ? `Forwarding: ${s.channels.email.address}` : !s.channels.email.available ? 'Not available yet' : null,
            s.channels.email.enabled && s.channels.email.address ? (
              <Button variant="secondary" size="sm" fullWidth onClick={() => copyAddress(s.channels.email.address!)}>
                Copy address
              </Button>
            ) : (
              turnOn('email', !s.channels.email.available)
            ),
          )}
        </div>
      )}
      <p className={cn('flex items-center gap-1.5 text-caption text-text-secondary')}>
        <ShieldCheck aria-hidden className="size-4 text-success" />
        Selling on Facebook, WhatsApp or Instagram too? Those channels are coming later.
        <button type="button" onClick={onOpenChannels} className="font-medium text-brand-600 hover:underline">
          See channels
        </button>
      </p>
    </section>
  );
}
