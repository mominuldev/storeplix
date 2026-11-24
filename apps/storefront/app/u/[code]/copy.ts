import type { UnsubscribeView } from '@/lib/storefront-api';

// PHASE-8-5 §8.6 page copy (pure; unit tested). English only: the storefront has no store-language setting yet, so
// "bn/en follows the store language" falls back to English (reported).

export type UnsubscribeScreen =
  | { kind: 'invalid' }
  | { kind: 'error' }
  | { kind: 'test'; storeName: string }
  | {
      kind: 'subscribed';
      storeName: string;
      channel: 'sms' | 'email';
      masked: string;
    }
  | {
      kind: 'unsubscribed';
      storeName: string;
      channel: 'sms' | 'email';
      masked: string;
    };

export function screenFor(
  result: { status: 'found'; data: UnsubscribeView } | { status: 'invalid' } | { status: 'error'; code: number },
): UnsubscribeScreen {
  if (result.status === 'invalid') return { kind: 'invalid' };
  if (result.status === 'error') return { kind: 'error' };
  const d = result.data;
  if (d.is_test) return { kind: 'test', storeName: d.store_name };
  return {
    kind: d.status,
    storeName: d.store_name,
    channel: d.channel,
    masked: d.masked_address,
  };
}

export const channelNoun = (c: 'sms' | 'email') => (c === 'sms' ? 'SMS' : 'emails');
export const channelBy = (c: 'sms' | 'email') => (c === 'sms' ? 'SMS' : 'email');

export function copyFor(s: UnsubscribeScreen): { title: string; body: string } {
  switch (s.kind) {
    case 'invalid':
      return {
        title: 'This link isn’t valid',
        body: 'Check that you opened the whole link from the message.',
      };
    case 'error':
      return {
        title: 'Something went wrong',
        body: 'We couldn’t load this page. Please try again in a minute.',
      };
    case 'test':
      return { title: 'This was a test message', body: 'Nothing changed.' };
    case 'subscribed':
      return {
        title: 'Unsubscribe from offers',
        body: `You get ${channelNoun(s.channel)} from ${s.storeName} at ${s.masked}.`,
      };
    case 'unsubscribed':
      return {
        title: 'You’re unsubscribed',
        body: `You won’t get offers from ${s.storeName} by ${channelBy(s.channel)}.`,
      };
  }
}
