import type { LaunchChecklist, LaunchItemKey } from '@storeplix/types';

// Go-live helpers for onboarding 07 (blocker links for 409 `launch_blocked`) and 08 ("Finish setting up").

export const blockerLinks: Record<LaunchItemKey, { label: string; to: string }> = {
  products: { label: 'Add a product', to: '/onboarding/products' },
  shipping: { label: 'Set delivery charges', to: '/onboarding/delivery' },
  payments: { label: 'Turn on cash on delivery', to: '/onboarding/payments' },
  contact_phone: { label: 'Add a contact phone', to: '/settings/store' },
  policy_pages: { label: 'Publish policy pages', to: '/online-store/pages' },
  first_order: { label: 'Get your first order', to: '/orders/new' },
};

const ITEMS: { key: LaunchItemKey | 'shop'; title: string; hint: string; to?: string }[] = [
  { key: 'shop', title: 'Create your shop', hint: '' },
  { key: 'products', title: 'Add your first product', hint: 'Photo, name and price', to: '/products/new' },
  { key: 'shipping', title: 'Set delivery charges', hint: 'Inside and outside Dhaka', to: '/settings/shipping' },
  { key: 'policy_pages', title: 'Add Bangla policy pages', hint: 'Return, delivery & privacy — ready-made templates', to: '/online-store/pages' },
  { key: 'first_order', title: 'Get your first order', hint: 'Share your link on your page, groups and WhatsApp status', to: '/orders' },
];

export function finishItems(c: LaunchChecklist, domain: string) {
  const done = (k: LaunchItemKey) => c.items.find((i) => i.key === k)?.done ?? false;
  return ITEMS.map((i) => ({ ...i, hint: i.key === 'shop' ? `${domain} is ${c.status === 'active' ? 'live' : 'ready'}` : i.hint, done: i.key === 'shop' ? true : done(i.key) }));
}
