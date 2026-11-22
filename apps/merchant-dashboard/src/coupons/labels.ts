import type { Coupon, CouponType } from '@storeplix/types';
import { formatBdt } from '../catalog/format';

export const couponTypeLabels: Record<CouponType, string> = { percentage: 'Percentage', fixed: 'Fixed amount', free_shipping: 'Free delivery' };

export function couponValue(c: Pick<Coupon, 'type' | 'percent_bps' | 'amount' | 'max_discount_amount'>): string {
  if (c.type === 'percentage') return `${(c.percent_bps ?? 0) / 100}% off${c.max_discount_amount ? ` · up to ${formatBdt(c.max_discount_amount)}` : ''}`;
  if (c.type === 'fixed') return `${formatBdt(c.amount ?? 0)} off`;
  return 'Free delivery';
}
