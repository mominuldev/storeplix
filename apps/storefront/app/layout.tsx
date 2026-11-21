import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { findCurrentStore, storeCssVars } from '@/lib/store';
import { fontVariables } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  icons: { icon: '/platform/storeplix-favicon.svg' },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Store errors are surfaced by the (store) segment's error boundary; never break the shell here.
  const store = await findCurrentStore().catch(() => null);
  return (
    <html lang="en" className={fontVariables} style={store ? storeCssVars(store) : undefined}>
      <body>{children}</body>
    </html>
  );
}
