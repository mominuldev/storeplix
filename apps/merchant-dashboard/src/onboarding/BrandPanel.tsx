import { Logo } from '@storeplix/ui';
import { CreditCard, MessageCircle, Shield, Star } from 'lucide-react';
import { images } from './assets';

const valueProps = [
  { icon: CreditCard, title: 'Free plan, no card needed', body: 'Up to 50 orders a month free. Upgrade only when you grow.' },
  { icon: Shield, title: 'Your money, your account', body: 'Cash on delivery or gateway — payouts go straight to you.' },
  { icon: MessageCircle, title: 'Bangla support from real people', body: 'Call or WhatsApp us, 9am–9pm, seven days a week.' },
];

export interface PitchCopy {
  eyebrow: string;
  headline: string;
  bangla: string;
}

// Figma Merchant Onboarding brand panel (01 46:8583, L1 57:911, L3 57:1198, L4 58:957):
// 560 wide, brand-600, p 48, justify-between: logo · pitch (gap 28) · testimonial.
export function BrandPanel({ eyebrow, headline, bangla }: PitchCopy) {
  return (
    <aside className="hidden w-[560px] shrink-0 flex-col justify-between bg-brand-600 p-12 text-text-inverse lg:flex">
      <Logo tone="white" height={32} />
      <div className="flex flex-col gap-7">
        <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-brand-500 px-3 py-1.5 text-caption font-medium">
          <Star aria-hidden className="size-3.5" /> {eyebrow}
        </span>
        <div className="flex flex-col gap-3">
          <h1 className="text-display">{headline}</h1>
          <p lang="bn" className="font-bangla text-[20px] leading-8 font-semibold text-brand-100">
            {bangla}
          </p>
        </div>
        <ul className="flex flex-col gap-[18px]">
          {valueProps.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex items-start gap-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand-500">
                <Icon aria-hidden className="size-5" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-body-lg font-medium">{title}</span>
                <span className="text-body text-brand-100">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <figure className="flex flex-col gap-3.5 rounded-card bg-brand-700 p-5">
        <blockquote className="text-body-lg">
          “I set up my shop in one evening. Now every order comes with a proper address and phone — no more inbox chaos.”
        </blockquote>
        <figcaption className="flex items-center gap-2.5">
          <img src={images.nusrat} alt="" width={36} height={36} className="size-9 rounded-full object-cover" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold">Nusrat Jahan</span>
            <span className="text-caption text-brand-100">Nusrat’s Closet · Chattogram</span>
          </span>
          <span className="flex items-center gap-1 text-caption font-medium">
            <Star aria-hidden className="size-3.5 fill-accent-500 text-accent-500" /> 4.8 · 2,300+ sellers
          </span>
        </figcaption>
      </figure>
    </aside>
  );
}
