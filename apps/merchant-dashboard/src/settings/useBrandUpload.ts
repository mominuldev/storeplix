import { isApiError } from '@storeplix/api-client';
import type { MediaPurpose } from '@storeplix/types';
import { useCallback, useState } from 'react';
import { api } from '../lib/api';

// Contract §1.5 limits, checked client-side for fast feedback (the server re-validates from the bytes).
export const uploadRules: Record<'logo' | 'favicon', { types: string[]; maxBytes: number; hint: string; accept: string }> = {
  logo: { types: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 2 * 1024 * 1024, accept: 'image/png,image/jpeg,image/webp', hint: 'PNG, JPG or WebP · up to 2 MB · at least 64 px' },
  favicon: { types: ['image/png'], maxBytes: 1024 * 1024, accept: 'image/png', hint: 'Square PNG · up to 1 MB · 64–1024 px' },
};

export function validateUpload(file: File, purpose: 'logo' | 'favicon'): string | null {
  const rule = uploadRules[purpose];
  if (!rule.types.includes(file.type)) return purpose === 'favicon' ? 'Favicons must be PNG files.' : 'Use a PNG, JPG or WebP image (SVG and GIF aren’t supported).';
  if (file.size > rule.maxBytes) return `This file is too large — the limit is ${rule.maxBytes / 1024 / 1024} MB.`;
  return null;
}

/** Upload → progress → poll until processed. Resolves the media id + display URL, or sets `error`. */
export function useBrandUpload(purpose: Extract<MediaPurpose, 'logo' | 'favicon'>) {
  const [progress, setProgress] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File): Promise<{ id: string; url: string } | null> => {
      const invalid = validateUpload(file, purpose);
      if (invalid) {
        setError(invalid);
        return null;
      }
      setError(null);
      setProgress(0);
      try {
        let media = await api.media.upload({ file, purpose }, { onProgress: setProgress });
        setProgress(null);
        if (media.status === 'processing') {
          setProcessing(true);
          media = await api.media.waitUntilProcessed(media);
        }
        if (media.status === 'failed') {
          setError('We couldn’t process this image. Try a different file.');
          return null;
        }
        if (media.status === 'processing') {
          setError('Processing is taking longer than usual. Try again in a minute.');
          return null;
        }
        const display = media.variants.find((v) => v.key === (purpose === 'logo' ? 'w320' : 'favicon_32'))?.url ?? media.url;
        return { id: media.id, url: display };
      } catch (e) {
        setError(isApiError(e) ? (e.fieldError('file') ?? e.message) : 'Upload failed. Please try again.');
        return null;
      } finally {
        setProgress(null);
        setProcessing(false);
      }
    },
    [purpose],
  );

  return { upload, progress, processing, error, rule: uploadRules[purpose] };
}
