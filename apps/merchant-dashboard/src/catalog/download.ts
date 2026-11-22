import type { DownloadedFile } from '@storeplix/api-client';

/** Saves a fetched CSV via a temporary object URL (needed because downloads carry the X-Tenant-Id header). */
export function saveFile({ blob, filename }: DownloadedFile) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
