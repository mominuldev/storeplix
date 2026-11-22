import { isApiError } from '@storeplix/api-client';
import { useCallback, useState } from 'react';
import { api } from '../lib/api';

export const PRODUCT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';
export const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export interface UploadedImage {
  media_id: string;
  url: string;
}

/**
 * Uploads product photos through POST /media (purpose `product_image`, contract P4-7) one at a time with a
 * progress fraction; waits for processing so the variants exist. Returns each ready image via `onAdded`.
 */
export function useProductImageUpload(onAdded: (img: UploadedImage) => void) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (files: File[], room: number) => {
      setError(null);
      const list = files.slice(0, Math.max(0, room));
      if (files.length > list.length) setError(room <= 0 ? 'You’ve added the most photos allowed.' : `Only the first ${list.length} photos were added.`);
      for (const file of list) {
        if (!PRODUCT_IMAGE_ACCEPT.split(',').includes(file.type)) {
          setError('Use JPG, PNG or WebP photos.');
          continue;
        }
        if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
          setError('A photo is over 10 MB. Use a smaller one.');
          continue;
        }
        setProgress(0);
        try {
          let media = await api.media.upload({ file, purpose: 'product_image' }, { onProgress: setProgress });
          if (media.status === 'processing') media = await api.media.waitUntilProcessed(media);
          if (media.status === 'failed') {
            setError('We couldn’t process a photo. Try a different file.');
            continue;
          }
          const url = media.variants.find((v) => v.key === 'w640')?.url ?? media.variants.find((v) => v.key === 'w320')?.url ?? media.url;
          onAdded({ media_id: media.id, url });
        } catch (e) {
          setError(isApiError(e) ? (e.fieldError('file') ?? e.message) : 'Upload failed. Please try again.');
        } finally {
          setProgress(null);
        }
      }
    },
    [onAdded],
  );

  return { upload, progress, error, setError };
}
