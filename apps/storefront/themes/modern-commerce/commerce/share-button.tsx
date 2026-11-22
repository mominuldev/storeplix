'use client';

import { useState } from 'react';
import { Icon } from '../components/icon';

/** Web Share API with a copy-link fallback. */
export function ShareButton({ title, url }: { title: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Share sheet dismissed or clipboard blocked: nothing to do.
    }
  };
  return (
    <button type="button" onClick={onClick} className="type-label-s flex items-center gap-2 text-brand hover:underline">
      <Icon name="share" />
      <span aria-live="polite">{copied ? 'Link copied' : 'Share'}</span>
    </button>
  );
}
