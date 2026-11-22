import type { StorefrontCommerce } from '@storeplix/types';
import { formatMoney } from '@/lib/format';
import { Icon } from '../components/icon';
import { deliveryDays } from './ui';

/** PDP delivery box (Figma 1:11034): zones from `config.commerce.delivery`, free-delivery line, COD. */
export function DeliveryBox({ commerce, currency }: { commerce: StorefrontCommerce | null; currency: string }) {
  if (!commerce) return null;
  const cod = commerce.payment_methods.includes('cod');
  if (commerce.delivery.length === 0 && !cod) return null;
  return (
    <div className="flex flex-col gap-3.5 rounded-sf-md bg-sunken p-4 lg:gap-4 lg:p-5" data-sp-delivery-box>
      {commerce.delivery.length > 0 ? (
        <div className="flex gap-3 lg:gap-3.5">
          <Icon name="truck-sm" size={22} className="text-brand" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="type-label-s text-ink lg:type-label-m">Delivery</p>
            <ul className="type-body-s flex flex-col gap-0.5 text-ink-muted">
              {commerce.delivery.map((z) => (
                <li key={z.name}>
                  {z.name} {z.charge_amount === 0 ? 'Free' : formatMoney(z.charge_amount, currency)} · {deliveryDays(z.min_days, z.max_days)}
                </li>
              ))}
              {commerce.free_delivery_over_amount !== null ? <li>Free delivery on orders over {formatMoney(commerce.free_delivery_over_amount, currency)}</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
      {cod ? (
        <div className="flex gap-3 lg:gap-3.5">
          <Icon name="wallet" size={22} className="text-brand" />
          <div className="flex flex-col gap-0.5">
            <p className="type-label-s text-ink lg:type-label-m">Cash on delivery available</p>
            <p className="type-body-s text-ink-muted">Pay in cash when the parcel arrives</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
