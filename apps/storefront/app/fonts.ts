import { Baloo_Da_2, Fraunces, Hind_Siliguri, Instrument_Sans, Inter, Noto_Serif_Bengali } from 'next/font/google';

// Self-hosted at build time by next/font. Only allowlisted families (themes/fonts.ts) exist.
export const instrumentSans = Instrument_Sans({ subsets: ['latin'], variable: '--font-instrument-sans', display: 'swap' });
export const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  style: ['normal', 'italic'],
  axes: ['SOFT', 'WONK', 'opsz'],
  display: 'swap',
});
export const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap', preload: false });
export const hindSiliguri = Hind_Siliguri({
  subsets: ['bengali', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-hind-siliguri',
  display: 'swap',
  preload: false,
});
export const notoSerifBengali = Noto_Serif_Bengali({
  subsets: ['bengali', 'latin'],
  variable: '--font-noto-serif-bengali',
  display: 'swap',
  preload: false,
});
export const balooDa2 = Baloo_Da_2({ subsets: ['bengali', 'latin'], variable: '--font-baloo-da-2', display: 'swap', preload: false });

export const fontVariables = [instrumentSans, fraunces, inter, hindSiliguri, notoSerifBengali, balooDa2]
  .map((f) => f.variable)
  .join(' ');
