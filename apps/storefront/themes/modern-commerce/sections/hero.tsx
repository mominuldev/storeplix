import type { SectionProps } from '../../types';
import type { HeroSettings } from '../schema';
import { formatPrice } from '@/lib/format';
import { getFeaturedProducts } from '@/lib/products';
import { ButtonLink } from '../components/button';
import { Icon } from '../components/icon';
import { ThemeImage } from '../components/theme-image';

/**
 * Figma "Hero" - desktop 1:10114, mobile 1:10337. Framed photo with hard offset shadow, tilted
 * detail frame, swing tag, rating pill and floating product card.
 */
export async function HeroSection({ settings: s, store, host }: SectionProps<HeroSettings>) {
  const [featured] = s.showFeaturedProduct ? await getFeaturedProducts(host, 1) : [];

  return (
    <section
      aria-labelledby="hero-heading"
      className="flex flex-col gap-6 px-4 pt-2 pb-12 xl:flex-row-reverse xl:items-center xl:gap-16 xl:px-20 xl:pt-16 xl:pb-24"
    >
      {/* Visual */}
      <div className="relative h-[400px] w-full shrink-0 xl:h-[640px] xl:w-[620px] max-xl:max-w-[358px]">
        <div className="absolute top-0 left-0 h-[388px] w-[346px] max-w-[calc(100%-12px)] overflow-hidden rounded-sf-xs border border-line bg-surface p-[9px] shadow-[10px_10px_0_0_var(--color-sun)] xl:top-4 xl:left-[110px] xl:h-[560px] xl:w-[490px] xl:max-w-none xl:p-[11px]">
          <div className="relative size-full overflow-hidden rounded-[2px]">
            <ThemeImage src={s.image} alt={s.imageAlt} sizes="(min-width: 1024px) 470px, 330px" priority />
          </div>
        </div>

        <div className="absolute top-[302px] left-[6px] hidden -rotate-5 xl:block">
          <div className="relative h-[212px] w-[180px] overflow-hidden rounded-sf-xs border border-line bg-surface p-[9px] shadow-[10px_10px_0_0_var(--color-accent)]">
            <div className="relative size-full overflow-hidden rounded-[2px]">
              <ThemeImage src={s.detailImage} alt="" sizes="162px" />
            </div>
          </div>
        </div>

        {s.tagLabel ? (
          <div className="absolute top-4 right-5 rotate-8 xl:top-2 xl:right-4 xl:rotate-9">
            <p className="type-accent-italic flex items-center gap-2.5 rounded-sf-sm bg-accent py-2 pr-3.5 pl-3 text-[16px] leading-[1.3] text-ink shadow-[10px_10px_0_0_var(--color-brand)] xl:py-3 xl:pr-5 xl:text-[20px]">
              <Icon name="eyelet" original />
              {s.tagLabel}
            </p>
          </div>
        ) : null}

        {s.ratingLabel ? (
          <p className="type-label-s absolute top-[335px] left-5 flex items-center gap-1.5 rounded-full bg-inverse px-3 py-2 text-paper xl:top-[42px] xl:left-[136px] xl:px-3.5">
            <Icon name="star-inverse" className="text-accent" />
            {s.ratingLabel}
          </p>
        ) : null}

        {featured ? (
          <a
            href={`/products/${encodeURIComponent(featured.slug)}`}
            className="absolute top-[520px] left-[290px] hidden items-center gap-3.5 rounded-sf-lg bg-surface p-3 shadow-e3 xl:flex"
          >
            <span className="relative size-16 shrink-0 overflow-hidden rounded-sf-md">
              <ThemeImage src={featured.image_url} alt="" sizes="64px" />
            </span>
            <span className="flex flex-col gap-0.5 pr-3 whitespace-nowrap">
              <span className="type-label-m text-ink">{featured.name}</span>
              {featured.subtitle ? <span className="type-body-s text-ink-muted">{featured.subtitle}</span> : null}
              <span className="type-price-m text-ink">{formatPrice(featured.price, store.currency)}</span>
            </span>
          </a>
        ) : null}
      </div>

      {/* Copy */}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-6 xl:gap-8">
        {s.eyebrow ? (
          <p className="type-eyebrow flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-accent-ink xl:gap-2 xl:px-3.5">
            <Icon name="snowflake" className="max-xl:size-3.5" />
            {s.eyebrow}
          </p>
        ) : null}
        <h1 id="hero-heading" className="type-display-m text-ink xl:type-display-xl">
          <span className="block">{s.heading}</span>
          {s.headingAccent ? <span className="type-accent-italic block text-brand">{s.headingAccent}</span> : null}
        </h1>
        <p className="type-body-m text-ink-secondary xl:type-body-l">{s.subheading}</p>
        <div className="flex w-full flex-col gap-2.5 xl:w-auto xl:flex-row xl:gap-3">
          <ButtonLink href={s.primaryCtaHref}>
            {s.primaryCtaLabel}
            <Icon name="arrow-right" />
          </ButtonLink>
          {s.secondaryCtaLabel && s.secondaryCtaHref ? (
            <ButtonLink href={s.secondaryCtaHref} variant="outline">
              {s.secondaryCtaLabel}
            </ButtonLink>
          ) : null}
        </div>
        {s.stats.length > 0 ? (
          <dl className="flex flex-wrap items-center gap-6 pt-2 xl:gap-8">
            {s.stats.map((stat, i) => (
              <div key={`${stat.label}-${i}`} className="flex items-center gap-6 xl:gap-8">
                {i > 0 ? <span aria-hidden className="h-10 w-px bg-line" /> : null}
                <div className="flex flex-col-reverse gap-0.5">
                  <dt className="type-body-s text-ink-muted">{stat.label}</dt>
                  <dd className="type-price-l text-ink">{stat.value}</dd>
                </div>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  );
}
