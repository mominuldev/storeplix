import type { PreviewToEditorMessage } from '@storeplix/types';
import { Button, Spinner } from '@storeplix/ui';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { embedUrl, usePreviewToken } from '../hooks';
import { postToPreview, previewOriginOf, readPreviewMessage } from './bridge';
import type { Device } from './editorReducer';

// Live preview iframe (contract P3-9/P3-10, §5.3). Loads `{preview url}&embed=1`, scales a 1440/834/390 px wide
// viewport to fit, refreshes via postMessage `refresh`, and falls back to reloading `src` when no `ready`
// arrives within 8 s; after a second failure it offers "Open preview in a new tab".

export const DEVICE_WIDTH: Record<Device, number> = { desktop: 1440, tablet: 834, phone: 390 };
const READY_TIMEOUT_MS = 8000;

export interface PreviewFrameHandle {
  refresh: () => void;
  select: (sectionId: string | null) => void;
}

interface Props {
  path: string;
  device: Device;
  onMessage?: (message: PreviewToEditorMessage) => void;
  onScale?: (scale: number) => void;
  label?: string;
}

export const PreviewFrame = forwardRef<PreviewFrameHandle, Props>(function PreviewFrame({ path, device, onMessage, onScale, label = 'Store preview' }, ref) {
  const token = usePreviewToken();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const src = token.data ? embedUrl(token.data.url, path) : null;
  const origin = previewOriginOf(src);
  const width = DEVICE_WIDTH[device];
  const scale = size.w ? Math.min(1, (size.w - 32) / width) : 1;

  useEffect(() => onScale?.(scale), [scale, onScale]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => entry && setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Messages from the preview: exact window + exact origin + schema (bridge.readPreviewMessage).
  useEffect(() => {
    const onWindowMessage = (event: MessageEvent) => {
      const msg = readPreviewMessage(event, iframeRef.current?.contentWindow, origin);
      if (!msg) return;
      if (msg.type === 'ready') {
        readyRef.current = true;
        setReady(true);
        setFailed(false);
        if (timer.current) clearTimeout(timer.current);
      }
      onMessageRef.current?.(msg);
    };
    window.addEventListener('message', onWindowMessage);
    return () => window.removeEventListener('message', onWindowMessage);
  }, [origin]);

  const armFallback = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    readyRef.current = false;
    timer.current = setTimeout(() => {
      if (readyRef.current) return;
      if (attempt === 0) setAttempt(1); // reload the iframe src once
      else setFailed(true);
    }, READY_TIMEOUT_MS);
  }, [attempt]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  useImperativeHandle(
    ref,
    () => ({
      refresh: () => {
        if (!postToPreview(iframeRef.current?.contentWindow, origin, { type: 'refresh' })) return;
        armFallback();
      },
      select: (sectionId) => {
        const frame = iframeRef.current?.contentWindow;
        postToPreview(frame, origin, { type: 'select', section_id: sectionId });
        if (sectionId) postToPreview(frame, origin, { type: 'scroll-to', section_id: sectionId });
      },
    }),
    [origin, armFallback],
  );

  return (
    <div ref={stageRef} className="relative flex min-h-0 flex-1 justify-center overflow-hidden px-4 pt-2 pb-4">
      {token.isPending ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner label="Preparing preview" />
        </div>
      ) : token.isError || !src ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-body text-text-secondary">
          <p>We couldn’t open the preview right now.</p>
          <Button size="sm" variant="secondary" leftIcon={<RefreshCw aria-hidden className="size-4" />} onClick={() => void token.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="relative shrink-0 origin-top" style={{ width, height: size.h ? (size.h - 24) / scale : 900, transform: `scale(${scale})` }}>
          <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border-default bg-surface-card shadow-elevation-1">
            <iframe
              key={`${src}#${attempt}`}
              ref={iframeRef}
              src={src}
              title={label}
              onLoad={armFallback}
              referrerPolicy="origin"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              className="min-h-0 w-full flex-1 bg-surface-card"
            />
          </div>
          {!ready && !failed && (
            <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-24">
              <Spinner label="Loading preview" />
            </div>
          )}
        </div>
      )}
      {failed && token.data && (
        <div role="alert" className="absolute inset-x-4 top-4 flex flex-wrap items-center justify-center gap-3 rounded-lg bg-warning-bg px-4 py-3 text-body text-text-primary">
          The preview isn’t responding.
          <a href={embedUrl(token.data.url, path, false)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline">
            Open preview in a new tab <ExternalLink aria-hidden className="size-4" />
          </a>
        </div>
      )}
    </div>
  );
});
