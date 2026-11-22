import type { SectionProps } from '../../types';
import type { HeroSettings, StatBlock } from '../schema';
import { formatMoney } from '@/lib/format';
import { getFeaturedProducts } from '@/lib/products';
import { DEMO, themeImage } from '../../media';
import { ButtonLink } from '../components/button';
import { Icon } from '../components/icon';
import { MaybeLink } from '../components/product-card';
import { ProductImage } from '../components/product-image';
import { ThemeImage } from '../components/theme-image';

const HEIGHT: Record<HeroSettings['height'], string> = { fit: '', half: 'xl:min-h-[50vh]', full: 'xl:min-h-[calc(100dvh-180px)]' };

/**
 * Figma "Hero" - desktop 1:10114, mobile 1:10337. Framed photo with hard offset shadow, tilted
 * detail frame, swing tag and floating product card (newest real product, or a placeholder).
 */
export async function HeroSection({ id, settings: s, blocks, ctx }: SectionProps<HeroSettings, StatBlock>) {
  const [featured] = s.showFeaturedProduct ? await getFeaturedProducts(ctx.host, 1, 'latest', { preview: ctx.preview }) : [];
  const image = themeImage(ctx.media, s.imageMediaId, `${DEMO}/hero-main.png`);
  const detail = themeImage(ctx.media, s.detailImageMediaId, `${DEMO}/cardigan.png`);
  const alt = s.imageAlt || image.alt || '';
  const headingId = `${id}-title`;

  const copy = (
    <div className="flex min-w-0 flex-1 flex-col items-start gap-6 xl:gap-8">
      {s.eyebrow ? (
        <p className="type-eyebrow flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-accent-ink xl:gap-2 xl:px-3.5">
          <Icon name="snowflake" className="max-xl:size-3.5" />
          {s.eyebrow}
        </p>
      ) : null}
      <h1 id={headingId} className="type-display-m text-ink xl:type-display-xl">
        <span className="block">{s.heading}</span>
        {s.headingAccent ? <span className="type-accent-italic block text-brand">{s.headingAccent}</span> : null}
      </h1>
      {s.subheading ? <p className="type-body-m text-ink-secondary xl:type-body-l">{s.subheading}</p> : null}
      {(s.primaryCtaLabel && s.primaryCtaHref) || (s.secondaryCtaLabel && s.secondaryCtaHref) ? (
        <div className="flex w-full flex-col gap-2.5 xl:w-auto xl:flex-row xl:gap-3">
          {s.primaryCtaLabel && s.primaryCtaHref ? (
            <ButtonLink href={s.primaryCtaHref}>
              {s.primaryCtaLabel}
              <Icon name="arrow-right" />
            </ButtonLink>
          ) : null}
          {s.secondaryCtaLabel && s.secondaryCtaHref ? (
            <ButtonLink href={s.secondaryCtaHref} variant="outline">
              {s.secondaryCtaLabel}
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
      {blocks.length > 0 ? (
        <dl className="flex flex-wrap items-center gap-6 pt-2 xl:gap-8">
          {blocks.map((b, i) => (
            <div key={b.id} className="flex items-center gap-6 xl:gap-8">
              {i > 0 ? <span aria-hidden className="h-10 w-px bg-line" /> : null}
              <div className="flex flex-col-reverse gap-0.5">
                <dt className="type-body-s text-ink-muted">{b.settings.label}</dt>
                <dd className="type-price-l text-ink">{b.settings.value}</dd>
              </div>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );

  if (s.layout === 'full_image') {
    return (
      <div className="px-4 xl:px-20">
        <div className={`relative isolate flex min-h-[520px] items-end overflow-hidden rounded-sf-sm p-6 xl:p-12 ${HEIGHT[s.height]}`}>
          <ThemeImage src={image.src} alt={alt} sizes="100vw" priority className="-z-10" />
          <div className="max-w-[640px] rounded-sf-sm bg-canvas/95 p-6 xl:p-10">{copy}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col gap-6 px-4 xl:items-center xl:gap-16 xl:px-20 ${s.layout === 'image_left' ? 'xl:flex-row' : 'xl:flex-row-reverse'} ${HEIGHT[s.height]}`}
    >
      {/* Visual */}
      <div className="relative h-[400px] w-full shrink-0 xl:h-[640px] xl:w-[620px] max-xl:max-w-[358px]">
        <div className="absolute top-0 left-0 h-[388px] w-[346px] max-w-[calc(100%-12px)] overflow-hidden rounded-sf-xs border border-line bg-surface p-[9px] shadow-[10px_10px_0_0_var(--color-sun)] xl:top-4 xl:left-[110px] xl:h-[560px] xl:w-[490px] xl:max-w-none xl:p-[11px]">
          <div className="relative size-full overflow-hidden rounded-[2px]">
            <ThemeImage src={image.src} alt={alt} sizes="(min-width: 1280px) 470px, 330px" priority />
          </div>
        </div>

        <div className="absolute top-[302px] left-[6px] hidden -rotate-5 xl:block">
          <div className="relative h-[212px] w-[180px] overflow-hidden rounded-sf-xs border border-line bg-surface p-[9px] shadow-[10px_10px_0_0_var(--color-accent)]">
            <div className="relative size-full overflow-hidden rounded-[2px]">
              <ThemeImage src={detail.src} alt="" sizes="162px" />
            </div>
          </div>
        </div>

        {s.tagLabel ? (
          <div className="absolute top-4 right-5 rotate-8 xl:top-2 xl:right-4 xl:rotate-9">
            <p className="type-accent-italic flex items-center gap-2.5 rounded-sf-sm bg-accent py-2 pr-3.5 pl-3 text-[16px] leading-[1.3] text-on-accent shadow-[10px_10px_0_0_var(--color-brand)] xl:py-3 xl:pr-5 xl:text-[20px]">
              <Icon name="eyelet" original />
              {s.tagLabel}
            </p>
          </div>
        ) : null}

        {featured ? (
          <MaybeLink
            href={featured.href}
            className="absolute top-[520px] left-[290px] hidden items-center gap-3.5 rounded-sf-lg bg-surface p-3 shadow-e3 xl:flex"
          >
            <span className="relative size-16 shrink-0 overflow-hidden rounded-sf-md">
              <ProductImage image={featured.image} sizes="64px" />
            </span>
            <span className="flex flex-col gap-0.5 pr-3 whitespace-nowrap">
              <span className="type-label-m text-[#0e1a33]">{featured.name}</span>
              {featured.subtitle ? <span className="type-body-s text-[#66728c]">{featured.subtitle}</span> : null}
              <span className="type-price-m text-[#0e1a33]">{formatMoney(featured.price_amount, featured.currency)}</span>
            </span>
          </MaybeLink>
        ) : null}
      </div>

      {copy}
    </div>
  );
}
