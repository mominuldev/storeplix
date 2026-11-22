import { ExternalLink, Search, ShoppingCart, Store } from 'lucide-react';
import { images } from './assets';

// Figma 03 Name your shop · preview pane (Shop preview 45:8103): 420 wide, brand-50, phone mock.
// Shop name/link are live; banner and products are Figma's sample content (illustrative only).
const products = [
  { name: 'Jamdani 3-Piece', price: '3,450', img: images.jamdani },
  { name: 'Silk Saree', price: '5,800', img: images.silkSaree },
  { name: 'Cotton Panjabi', price: '1,850', img: images.cottonPanjabi },
  { name: 'Kids Kurti', price: '950', img: images.kidsKurti },
];

/** `color` (validated #rrggbb) tints the mock: it overrides the brand tokens for this subtree only. */
export interface PreviewProduct {
  name: string;
  price: string;
  img: string | null;
}

/** `products` replaces the sample grid (onboarding 05 lists the products added in this session). */
export function PhonePreview({
  name,
  domain,
  color,
  logoUrl,
  caption = 'Updates as you type',
  products: own,
  footer,
}: {
  name: string;
  domain: string;
  color?: string;
  logoUrl?: string | null;
  caption?: string;
  products?: PreviewProduct[];
  footer?: React.ReactNode;
}) {
  const list: PreviewProduct[] = own && own.length ? own : products;
  const initial = name.trim().charAt(0).toUpperCase() || 'S';
  const tint = color && /^#[0-9a-f]{6}$/i.test(color) ? ({ '--color-brand-600': color, '--color-brand-700': color } as React.CSSProperties) : undefined;
  return (
    <aside aria-label="Live preview" style={tint} className="hidden w-[420px] shrink-0 flex-col items-center gap-5 bg-brand-50 px-10 py-8 xl:flex">
      <div className="flex w-full items-center justify-between">
        <span className="flex items-center gap-2 text-caption font-medium text-brand-700">
          <span className="size-2 rounded-full bg-success" /> Live preview
        </span>
        <span className="text-caption text-text-muted">{caption}</span>
      </div>
      <div className="rounded-[44px] bg-text-primary p-2.5">
        <div className="flex h-[580px] w-[280px] flex-col gap-3 overflow-hidden rounded-[34px] bg-surface-canvas pb-4">
          <div className="flex items-center justify-between px-6 pt-3 text-caption font-medium text-text-primary">
            <span>9:41</span>
            <span>5G 100%</span>
          </div>
          <div className="flex items-center gap-2 px-4">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="size-[30px] rounded-full object-cover" />
            ) : (
              <span className="flex size-[30px] items-center justify-center rounded-full bg-brand-600 text-body font-semibold text-text-inverse">{initial}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-body font-semibold text-text-primary">{name || 'Your shop'}</span>
            <Search aria-hidden className="size-[18px]" />
            <ShoppingCart aria-hidden className="size-[18px]" />
          </div>
          <div className="px-4">
            <div className="flex gap-2.5 rounded-[14px] bg-brand-600 p-3.5 text-text-inverse">
              <div className="flex flex-1 flex-col gap-1.5">
                <span lang="bn" className="font-bangla text-[20px] leading-7 font-semibold">
                  ঈদ কালেকশন
                </span>
                <span className="text-caption">Up to 20% off · free delivery in Dhaka</span>
                <span className="self-start rounded-full bg-surface-card px-3 py-[5px] text-caption font-medium text-brand-600">Shop now</span>
              </div>
              <img src={images.silkSaree} alt="" width={78} height={96} className="h-24 w-[78px] rounded-control object-cover" />
            </div>
          </div>
          <div className="flex gap-1.5 px-4 text-caption">
            <span className="rounded-full bg-brand-600 px-2.5 py-[5px] text-text-inverse">All</span>
            {['Saree', 'Three-piece', 'Panjabi'].map((c) => (
              <span key={c} className="rounded-full border border-border-default bg-surface-card px-2.5 py-[5px] text-text-secondary">
                {c}
              </span>
            ))}
          </div>
          <div className="flex items-center justify-between px-4">
            <span className="text-body font-semibold text-text-primary">New arrivals</span>
            <span className="text-caption font-medium text-brand-600">See all</span>
          </div>
          <div className="grid grid-cols-2 gap-x-2.5 gap-y-3 px-4">
            {list.map((p, i) => (
              <div key={`${p.name}-${i}`} className="flex flex-col gap-1">
                {p.img ? (
                  <img src={p.img} alt="" width={119} height={138} className="h-[138px] w-full rounded-control object-cover" />
                ) : (
                  <span className="h-[138px] w-full rounded-control bg-surface-subtle" />
                )}
                <span className="truncate text-caption font-medium text-text-primary">{p.name}</span>
                <span className="text-caption font-medium text-brand-700">
                  <span className="font-bangla">৳</span> {p.price}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <span className="flex items-center gap-2 rounded-full border border-border-default bg-surface-card px-3.5 py-2 text-body font-medium text-text-primary">
        <Store aria-hidden className="size-4" /> {domain}
        <ExternalLink aria-hidden className="size-3.5" />
      </span>
      {footer}
    </aside>
  );
}
