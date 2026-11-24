import type { CampaignLanguage } from '@storeplix/types';

// PHASE-8-5 Q150: four built-in templates (Figma "Template: Win-back with coupon"), client-side only and editable after
// insert. Bodies use the §P85-20 merge fields; the server adds the "{Shop}: " prefix and the opt-out footer itself, so
// templates never include either. Subjects are used for email campaigns.

export type TemplateKey = 'win_back' | 'new_arrivals' | 'flash_sale' | 'eid';

export interface CampaignTemplate {
  key: TemplateKey;
  label: string;
  /** Needs a coupon picked (`{coupon}` in the body). */
  usesCoupon: boolean;
  /** Needs a product picked (`{product}` in the body). */
  usesProduct: boolean;
  text: Record<CampaignLanguage, { subject: string; body: string }>;
}

export const CAMPAIGN_TEMPLATES: readonly CampaignTemplate[] = [
  {
    key: 'win_back',
    label: 'Win-back with coupon',
    usesCoupon: true,
    usesProduct: false,
    text: {
      bn: {
        subject: 'আপনাকে মিস করছি — আপনার জন্য বিশেষ ছাড়',
        body: 'প্রিয় {name}, অনেকদিন দেখা নেই! আপনার জন্য বিশেষ ছাড় — কোড {coupon}। নতুন কালেকশন দেখুন: {shop_link}',
      },
      en: {
        subject: 'We miss you — a little something for you',
        body: 'Hi {name}, it has been a while! Here is a special discount just for you. Use code {coupon} at {shop_link}',
      },
    },
  },
  {
    key: 'new_arrivals',
    label: 'New arrivals',
    usesCoupon: false,
    usesProduct: true,
    text: {
      bn: {
        subject: 'নতুন এসেছে — আপনার জন্য বেছে রাখা',
        body: 'প্রিয় {name}, নতুন এসেছে: {product}',
      },
      en: {
        subject: 'Just in — picked for you',
        body: 'Hi {name}, new in store: {product}',
      },
    },
  },
  {
    key: 'flash_sale',
    label: 'Flash sale',
    usesCoupon: true,
    usesProduct: false,
    text: {
      bn: {
        subject: 'ফ্ল্যাশ সেল — শুধু আজ',
        body: 'ফ্ল্যাশ সেল শুধু আজ! কোড {coupon} দিয়ে অর্ডার করুন: {shop_link}',
      },
      en: {
        subject: 'Flash sale — today only',
        body: 'Flash sale today only! Use code {coupon} at {shop_link}',
      },
    },
  },
  {
    key: 'eid',
    label: 'Eid greeting',
    usesCoupon: false,
    usesProduct: false,
    text: {
      bn: {
        subject: 'ঈদ মোবারক!',
        body: 'ঈদ মোবারক, {name}! আমাদের ঈদ কালেকশন দেখুন: {shop_link}',
      },
      en: {
        subject: 'Eid Mubarak!',
        body: 'Eid Mubarak, {name}! See our Eid collection: {shop_link}',
      },
    },
  },
];
