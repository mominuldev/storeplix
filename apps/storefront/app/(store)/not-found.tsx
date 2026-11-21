import { ThemeNotFound } from '@/themes/modern-commerce/not-found';

/** Page-level 404 inside an existing store; the (store) layout already renders the theme chrome. */
export default function StorePageNotFound() {
  return <ThemeNotFound />;
}
