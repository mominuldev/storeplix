import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';
import { qrDataUrl } from '../lib/qr';

export function QrCode({ value, size = 112, label, className }: { value: string; size?: number; label: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    qrDataUrl(value, size * 2).then(
      (url) => alive && setSrc(url),
      () => alive && setSrc(null),
    );
    return () => {
      alive = false;
    };
  }, [value, size]);
  return (
    <span className={cn('inline-flex items-center justify-center bg-surface-card', className)} style={{ width: size, height: size }}>
      {src ? <img src={src} alt={label} width={size} height={size} /> : <span role="img" aria-label={label} className="size-full animate-pulse rounded-sm bg-surface-subtle" />}
    </span>
  );
}

