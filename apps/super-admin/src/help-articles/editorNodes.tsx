import type { HelpCalloutTone, HelpMediaRef } from '@storeplix/types';
import { cn } from '@storeplix/ui';
import { mergeAttributes, Node } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { ImageIcon, Trash2 } from 'lucide-react';
import { createContext, use } from 'react';
import { CALLOUT_LABELS, CALLOUT_TONES } from './doc';

// The two HelpArticleDoc block types outside RichTextDoc (P89C-5) as Tiptap nodes. Node names match the doc's block
// types so `editor.getJSON()` only needs `toHelpDoc` (no renaming). Neither parses pasted HTML <img>/<iframe>: only
// our own `figure[data-help-image]` / `div[data-callout]` markup round-trips, anything else is dropped by Tiptap.

/** media_id → ref for node views (article media + images uploaded in this session). */
export const HelpMediaContext = createContext<Record<string, HelpMediaRef>>({});

const calloutTone: Record<HelpCalloutTone, string> = {
  info: 'border-info bg-info-bg',
  warning: 'border-warning bg-warning-bg',
  tip: 'border-success bg-success-bg',
};

function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const tone = (node.attrs.tone as HelpCalloutTone) ?? 'info';
  return (
    <NodeViewWrapper className={cn('my-2 rounded-md border-l-[3px] px-3 py-2', calloutTone[tone])} data-callout="">
      <div contentEditable={false} className="flex items-center gap-2 pb-1 select-none">
        <span className="text-caption font-medium text-text-secondary">Callout</span>
        <select
          aria-label="Callout style"
          value={tone}
          disabled={!editor.isEditable}
          onChange={(e) => updateAttributes({ tone: e.target.value })}
          className="rounded-sm border border-border-default bg-surface-card px-1.5 py-0.5 text-caption text-text-primary outline-none focus-visible:shadow-focus"
        >
          {CALLOUT_TONES.map((t) => (
            <option key={t} value={t}>
              {CALLOUT_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      <NodeViewContent className="text-text-primary" />
    </NodeViewWrapper>
  );
}

function ImageView({ node, updateAttributes, deleteNode, editor, selected }: NodeViewProps) {
  const media = use(HelpMediaContext);
  const mediaId = node.attrs.media_id as string;
  const ref = media[mediaId];
  const alt = (node.attrs.alt as string) ?? '';
  const caption = (node.attrs.caption as string | null) ?? '';
  const disabled = !editor.isEditable;
  return (
    <NodeViewWrapper data-help-image="" className={cn('my-2 flex gap-3 rounded-md bg-surface-subtle p-3', selected && 'shadow-focus')}>
      <div contentEditable={false} className="flex w-full gap-3">
        {ref?.url ? (
          <img src={ref.variants.w640 ?? ref.url} alt="" className="h-16 w-24 shrink-0 rounded-sm object-cover" />
        ) : (
          <span className="flex h-16 w-24 shrink-0 items-center justify-center rounded-sm bg-surface-card text-text-muted">
            <ImageIcon aria-hidden className="size-5" />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-caption text-text-secondary">
            Image{ref?.width && ref.height ? ` · ${ref.width} × ${ref.height}` : ''}
            {ref?.status === 'processing' && ' · processing…'}
            {ref?.status === 'failed' && <span className="text-danger"> · failed — replace it</span>}
          </span>
          <input
            aria-label="Alt text"
            placeholder="Alt text (required) — describe the image"
            value={alt}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => updateAttributes({ alt: e.target.value })}
            className={cn(
              'rounded-sm border bg-surface-card px-2 py-1 text-caption text-text-primary outline-none focus:border-brand-600',
              alt.trim() ? 'border-border-default' : 'border-danger',
            )}
          />
          {!alt.trim() && <span className="text-caption text-danger">Add alt text so every merchant can understand the image.</span>}
          <input
            aria-label="Caption"
            placeholder="Caption (optional)"
            value={caption}
            disabled={disabled}
            onChange={(e) => updateAttributes({ caption: e.target.value || null })}
            className="rounded-sm border border-border-default bg-surface-card px-2 py-1 text-caption text-text-primary outline-none focus:border-brand-600"
          />
        </div>
        {!disabled && (
          <button type="button" aria-label="Remove image" onClick={() => deleteNode()} className="self-start rounded-sm p-1 text-text-muted outline-none hover:bg-surface-card hover:text-danger focus-visible:shadow-focus">
            <Trash2 aria-hidden className="size-4" />
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const HelpImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      media_id: { default: null, parseHTML: (el) => el.getAttribute('data-media-id'), renderHTML: (a) => ({ 'data-media-id': a.media_id as string }) },
      alt: { default: '', parseHTML: (el) => el.getAttribute('data-alt') ?? '', renderHTML: (a) => ({ 'data-alt': a.alt as string }) },
      caption: { default: null, parseHTML: (el) => el.getAttribute('data-caption'), renderHTML: (a) => (a.caption ? { 'data-caption': a.caption as string } : {}) },
    };
  },
  parseHTML() {
    return [{ tag: 'figure[data-help-image]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes({ 'data-help-image': '' }, HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

export const HelpCallout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'paragraph+',
  defining: true,
  addAttributes() {
    return { tone: { default: 'info', parseHTML: (el) => el.getAttribute('data-tone') ?? 'info', renderHTML: (a) => ({ 'data-tone': a.tone as string }) } };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-callout': '' }, HTMLAttributes), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});
