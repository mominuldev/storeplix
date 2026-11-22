import { isApiError } from '@storeplix/api-client';
import type { CustomerSmsEvent, UpdateStoreSettingsInput } from '@storeplix/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { settingsKey } from './schema';

export function useStoreSettings() {
  const { storeId } = useStoreScope();
  return useQuery({ queryKey: settingsKey(storeId ?? undefined), queryFn: () => api.stores.getSettings(storeId!), enabled: !!storeId, retry: false });
}

export function useSaveSettings(success = 'Saved.') {
  const { storeId } = useStoreScope();
  const qc = useQueryClient();
  const invalidate = useCommerceInvalidate();
  return useMutation({
    mutationFn: (input: UpdateStoreSettingsInput) => api.stores.updateSettings(storeId!, input),
    onSuccess: async (s) => {
      qc.setQueryData(settingsKey(storeId ?? undefined), s);
      toast(success);
      await invalidate.launch();
    },
    onError: (e) => toast(isApiError(e) ? (Object.values(e.details ?? {})[0]?.[0] ?? e.message) : errorMessage(e), 'error'),
  });
}

/** Fixed templates (contract §8) filled with a sample order — read-only preview. */
export function smsPreview(event: CustomerSmsEvent, lang: 'bn' | 'en', shop: string): string {
  const s = { first: 'Nasrin', number: 'GS-1042', total: '1,770', due: '1,770', carrier: 'Steadfast', track: 'shop.storeplix.com/track' };
  if (lang === 'bn') {
    return {
      order_placed: `প্রিয় ${s.first}, ${shop} এ আপনার অর্ডার ${s.number} পেয়েছি। মোট ${s.total} টাকা, ডেলিভারির সময় পরিশোধ করবেন। ট্র্যাক: ${s.track}`,
      order_confirmed: `${shop}: আপনার অর্ডার ${s.number} কনফার্ম হয়েছে।`,
      order_shipped: `${shop}: অর্ডার ${s.number} ${s.carrier} এর মাধ্যমে পাঠানো হয়েছে। ${s.due} টাকা প্রস্তুত রাখুন। ট্র্যাক: ${s.track}`,
      order_cancelled: `${shop}: অর্ডার ${s.number} বাতিল করা হয়েছে।`,
      payment_link: `${shop}: অর্ডার ${s.number} নিশ্চিত করতে ${s.due} টাকা পরিশোধ করুন: ${s.track}`,
      order_updated: `${shop}: অর্ডার ${s.number} আপডেট হয়েছে। নতুন মোট ${s.total} টাকা।`,
    }[event];
  }
  return {
    order_placed: `${shop}: Order ${s.number} received. Total Tk ${s.total}, pay on delivery. Track: ${s.track}`,
    order_confirmed: `${shop}: Order ${s.number} is confirmed.`,
    order_shipped: `${shop}: Order ${s.number} sent with ${s.carrier}. Keep Tk ${s.due} ready. Track: ${s.track}`,
    order_cancelled: `${shop}: Order ${s.number} has been cancelled.`,
    payment_link: `${shop}: Pay Tk ${s.due} to confirm order ${s.number}: ${s.track}`,
    order_updated: `${shop}: Order ${s.number} was updated. New total Tk ${s.total}.`,
  }[event];
}

/** P5B-56: VAT included in a total = floor(total × rate / (10 000 + rate)); totals don't change. */
export function vatIncluded(total: number, rateBps: number): number {
  return Math.floor((total * rateBps) / (10_000 + rateBps));
}
