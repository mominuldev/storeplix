import Link from 'next/link';

/** Page-level 404 inside an existing store; the (store) layout already renders the theme chrome. */
export default function StorePageNotFound() {
  return (
    <section className="flex flex-col items-center gap-4 px-4 py-24 text-center">
      <p className="type-eyebrow text-accent-ink">404</p>
      <h1 className="type-display-m text-ink">Page not found</h1>
      <p className="type-body-m text-ink-secondary">We couldn’t find the page you were looking for.</p>
      <Link href="/" className="type-label-m rounded-full bg-brand px-7 py-4 text-on-brand">
        Back to the store
      </Link>
    </section>
  );
}
