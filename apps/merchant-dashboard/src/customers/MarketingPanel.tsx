import type { CustomerMarketing, MarketingChannel } from '@storeplix/types';
import { Badge, Button, type BadgeTone } from '@storeplix/ui';
import { shortDate } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { marketingStateLabel } from '../campaigns/campaigns';
import { useCustomerOptOut } from '../campaigns/queries';
import { Panel } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';

// PHASE-8-5 §8.5 customer detail "Marketing" row: SMS / Email each Subscribed · Unsubscribed <date> (by customer|by you)
// · Not eligible · No address, with "Stop marketing messages" / "Allow again" (merchant-owned only) for `customers.edit`.

const tone: Record<CustomerMarketing['sms'], BadgeTone> = { subscribed: 'success', unsubscribed: 'danger', not_eligible: 'neutral', no_address: 'neutral' };

export function MarketingPanel({ customer }: { customer: { id: string; name: string; marketing?: CustomerMarketing } }) {
  const scope = useStoreScope();
  if (!customer.marketing) return null; // API older than 8.5
  return (
    <Panel title="Marketing" description="Campaign SMS and email">
      <dl className="flex flex-col gap-3">
        <ChannelRow customerId={customer.id} name={customer.name} marketing={customer.marketing} channel="sms" canEdit={scope.canEditCustomers} />
        <ChannelRow customerId={customer.id} name={customer.name} marketing={customer.marketing} channel="email" canEdit={scope.canEditCustomers} />
      </dl>
    </Panel>
  );
}

function ChannelRow({ customerId, name, marketing: m, channel, canEdit }: { customerId: string; name: string; marketing: CustomerMarketing; channel: MarketingChannel; canEdit: boolean }) {
  const optOut = useCustomerOptOut(customerId);
  const label = channel === 'sms' ? 'SMS' : 'Email';
  const state = m[channel];
  const at = channel === 'sms' ? m.unsubscribed_sms_at : m.unsubscribed_email_at;
  const source = m.unsubscribed_source[channel];
  const status = state === 'unsubscribed' ? `Unsubscribed${at ? ` ${shortDate(at)}` : ''} (${source === 'merchant' ? 'by you' : 'by customer'})` : marketingStateLabel[state];
  const act = (stop: boolean) =>
    optOut.mutate(
      { channel, stop },
      {
        onSuccess: () => toast(stop ? `${label} marketing stopped for ${name}.` : `${label} marketing allowed again for ${name}.`),
        onError: (e) => toast(errorMessage(e), 'error'),
      },
    );
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`marketing-${channel}`}>
      <dt className="w-12 shrink-0 text-caption text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1">
        <Badge size="sm" tone={tone[state]}>
          {status}
        </Badge>
      </dd>
      {canEdit && state === 'subscribed' && (
        <Button size="sm" variant="secondary" loading={optOut.isPending} onClick={() => act(true)}>
          Stop marketing messages
        </Button>
      )}
      {canEdit && state === 'unsubscribed' && source === 'merchant' && (
        <Button size="sm" variant="secondary" loading={optOut.isPending} onClick={() => act(false)}>
          Allow again
        </Button>
      )}
    </div>
  );
}
