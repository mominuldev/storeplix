import type { SectionProps } from '../../types';
import type { ReviewBlock, ReviewsClubSettings } from '../schema';
import { ButtonLink } from '../components/button';
import { Icon } from '../components/icon';

const TINTS = ['bg-accent-soft', 'bg-sky-tint', 'bg-sun-soft', 'bg-brand-soft'];

/**
 * Figma "Reviews & club" - desktop 1:10297, mobile 1:10461. The club card is a link, not a
 * signup form (newsletter capture belongs to Marketing, later).
 */
export function ReviewsClubSection({ id, settings: s, blocks }: SectionProps<ReviewsClubSettings, ReviewBlock>) {
  const club = s.club;
  const showClub = club.enabled && (club.heading || club.text || (club.ctaLabel && club.ctaHref));
  if (blocks.length === 0 && !showClub && !s.title) return null;

  return (
    <div className="flex flex-col gap-4 px-4 lg:flex-row lg:items-stretch lg:gap-6 lg:px-20">
      <div className="flex min-w-0 flex-col gap-6 lg:flex-[2]">
        {s.title || s.subtitle ? (
          <div className="flex flex-col gap-2">
            {s.subtitle ? <p className="type-eyebrow text-accent-ink">{s.subtitle}</p> : null}
            {s.title ? (
              <h2 id={`${id}-title`} className="type-display-m text-ink max-md:text-[36px]">
                {s.title}
              </h2>
            ) : null}
          </div>
        ) : null}
        {blocks.length > 0 ? (
          <ul className="flex flex-col gap-4 text-[#0e1a33] md:flex-row md:gap-6">
            {blocks.map((b, i) => (
              <li key={b.id} className={`flex min-w-0 flex-1 flex-col gap-5 rounded-sf-xl p-6 lg:p-8 ${TINTS[i % TINTS.length]} ${i >= 2 ? 'max-md:hidden' : ''}`}>
                <figure className="flex flex-col gap-5">
                  <span className="flex gap-1 text-sale" role="img" aria-label={`${b.settings.rating} out of 5 stars`}>
                    {Array.from({ length: b.settings.rating }, (_, k) => (
                      <Icon key={k} name="star-outline" />
                    ))}
                  </span>
                  <blockquote className="type-accent-italic-s">“{b.settings.quote}”</blockquote>
                  <figcaption className="flex flex-col gap-0.5">
                    <span className="type-label-m">{b.settings.author}</span>
                    {b.settings.location ? <span className="type-body-s text-[#66728c]">{b.settings.location}</span> : null}
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {showClub ? (
        <div className="flex flex-col items-start gap-5 rounded-sf-xl bg-brand p-6 text-on-brand lg:flex-1 lg:p-10">
          {club.heading ? <h3 className="type-h1 max-md:text-[28px]">{club.heading}</h3> : null}
          {club.text ? <p className="type-body-m opacity-85">{club.text}</p> : null}
          {club.ctaLabel && club.ctaHref ? (
            <ButtonLink href={club.ctaHref} variant="inverse" className="w-full">
              {club.ctaLabel}
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
