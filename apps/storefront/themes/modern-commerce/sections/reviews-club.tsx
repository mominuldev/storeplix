import type { SectionProps } from '../../types';
import type { ReviewBlock, ReviewsClubSettings } from '../schema';
import { ButtonLink } from '../components/button';
import { Icon } from '../components/icon';

const TINTS = ['bg-accent-soft', 'bg-sky-tint', 'bg-sun-soft', 'bg-brand-soft'];

/**
 * Figma "Reviews & club" - desktop 1:10297, tablet 1:10612 (club card only), mobile 1:10461. The club card is a link, not a
 * signup form (newsletter capture belongs to Marketing, later).
 */
export function ReviewsClubSection({ id, settings: s, blocks }: SectionProps<ReviewsClubSettings, ReviewBlock>) {
  const club = s.club;
  const showClub = club.enabled && (club.heading || club.text || (club.ctaLabel && club.ctaHref));
  if (blocks.length === 0 && !showClub && !s.title) return null;

  return (
    <div className="flex flex-col gap-4 px-4 md:px-10 lg:flex-row lg:items-stretch lg:gap-6 lg:px-20">
      <div className="flex min-w-0 flex-col gap-4 md:gap-6 md:max-lg:hidden lg:w-[62.5%] lg:shrink-0">
        {s.title || s.subtitle ? (
          <div className="flex flex-col gap-4 md:gap-2">
            {s.subtitle ? <p className="type-eyebrow text-accent-ink">{s.subtitle}</p> : null}
            {s.title ? (
              <h2 id={`${id}-title`} className="type-h1 text-ink md:type-display-m">
                {s.title}
              </h2>
            ) : null}
          </div>
        ) : null}
        {blocks.length > 0 ? (
          <ul className="flex flex-col gap-4 text-[#0e1a33] md:flex-row md:gap-6">
            {blocks.map((b, i) => (
              <li key={b.id} className={`flex min-w-0 flex-1 flex-col rounded-sf-lg p-6 md:rounded-sf-xl lg:p-8 ${TINTS[i % TINTS.length]} ${i >= 1 ? 'max-md:hidden' : ''}`}>
                <figure className="flex flex-col gap-3.5 md:gap-5">
                  <span className="flex gap-[3px] text-sale md:gap-1" role="img" aria-label={`${b.settings.rating} out of 5 stars`}>
                    {Array.from({ length: b.settings.rating }, (_, k) => (
                      <Icon key={k} name="star-outline" className="max-md:size-3.5" />
                    ))}
                  </span>
                  <blockquote className="type-accent-italic-s">“{b.settings.quote}”</blockquote>
                  <figcaption className="flex flex-col gap-0.5">
                    {/* Figma mobile 1:10464 sets author and place on one muted Label/S line. */}
                    <span className="type-label-s text-[#66728c] md:type-label-m md:text-inherit">
                      {b.settings.author}
                      {b.settings.location ? <span className="md:hidden"> · {b.settings.location}</span> : null}
                    </span>
                    {b.settings.location ? <span className="type-body-s hidden text-[#66728c] md:block">{b.settings.location}</span> : null}
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {showClub ? (
        <div className="flex flex-col items-start gap-3.5 rounded-sf-lg bg-brand p-6 text-on-brand md:flex-row md:items-center md:justify-between md:gap-8 md:rounded-sf-xl md:p-10 lg:min-w-0 lg:flex-1 lg:flex-col lg:items-start lg:justify-start lg:gap-5">
          {club.heading ? <h3 className="type-h2 md:max-w-[322px] lg:type-h1 lg:max-w-none">{club.heading}</h3> : null}
          {club.text ? <p className="type-body-m hidden opacity-85 lg:block">{club.text}</p> : null}
          {club.ctaLabel && club.ctaHref ? (
            <ButtonLink href={club.ctaHref} variant="inverse" className="w-full md:w-[320px] md:shrink-0 lg:w-full">
              {club.ctaLabel}
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
