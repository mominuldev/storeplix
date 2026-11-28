import type { HelpArticleDoc, HelpMediaRef } from '@storeplix/types';
import { SegmentedControl, SkeletonRows } from '@storeplix/ui';
import { lazy, Suspense, useState } from 'react';
import { HelpArticleBody } from './articleBody';
import { wordStats } from './doc';
import { docToMarkdown, markdownToDoc, type MarkdownProblem } from './markdown';

const RichEditor = lazy(() => import('./RichEditor'));

export type BodyMode = 'write' | 'markdown' | 'preview';

// Article body with Write / Markdown / Preview (2134:66712). Markdown is converted in the browser on every edit; while
// it has unsupported syntax the doc is not updated (nothing is sent) and switching away is blocked with the reasons.
export function ArticleBodyField({
  value,
  onChange,
  media,
  onMediaAdded,
  languageLabel,
  disabled,
}: {
  value: HelpArticleDoc;
  onChange: (doc: HelpArticleDoc) => void;
  media: Record<string, HelpMediaRef>;
  onMediaAdded: (ref: HelpMediaRef) => void;
  languageLabel: string;
  disabled?: boolean;
}) {
  const [mode, setMode] = useState<BodyMode>('write');
  const [markdown, setMarkdown] = useState('');
  const [problems, setProblems] = useState<MarkdownProblem[]>([]);
  const [blocked, setBlocked] = useState(false);
  const stats = wordStats(value);

  const switchTo = (next: BodyMode) => {
    if (next === mode) return;
    if (mode === 'markdown' && problems.length) {
      setBlocked(true);
      return;
    }
    setBlocked(false);
    if (next === 'markdown') {
      setMarkdown(docToMarkdown(value));
      setProblems([]);
    }
    setMode(next);
  };

  const onMarkdown = (text: string) => {
    setMarkdown(text);
    const result = markdownToDoc(text);
    setProblems(result.problems);
    if (!result.problems.length) {
      setBlocked(false);
      onChange(result.doc);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-body font-medium text-text-primary">Article</span>
        <SegmentedControl
          aria-label="Editor mode"
          size="sm"
          value={mode}
          onChange={switchTo}
          options={[
            { value: 'write', label: 'Write' },
            { value: 'markdown', label: 'Markdown' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
      </div>
      {mode === 'write' && (
        <Suspense fallback={<SkeletonRows rows={4} label="Loading editor" />}>
          <RichEditor value={value} onChange={onChange} media={media} onMediaAdded={onMediaAdded} label={`Article (${languageLabel})`} disabled={disabled} />
        </Suspense>
      )}
      {mode === 'markdown' && (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={`Article Markdown (${languageLabel})`}
            value={markdown}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => onMarkdown(e.target.value)}
            className="min-h-72 rounded-md border border-border-default bg-surface-card px-4 py-3 font-mono text-[13px] leading-5 text-text-primary outline-none focus:border-brand-600"
          />
          <p className="text-caption text-text-muted">
            ## heading · ### subheading · - list · 1. steps · **bold** · *italic* · [link](/help/articles/slug) · :::tip … ::: · images: use Write → Image
          </p>
          {problems.length > 0 && (
            <div role="alert" className="flex flex-col gap-1 rounded-md bg-danger-bg px-3 py-2 text-caption text-danger">
              <span className="font-medium">
                {blocked ? 'Fix these lines before leaving Markdown — nothing was saved from them:' : 'Not saved yet — these lines use syntax help articles don’t support:'}
              </span>
              <ul className="list-disc pl-4">
                {problems.slice(0, 8).map((p, i) => (
                  <li key={i}>
                    Line {p.line}: {p.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {mode === 'preview' && (
        <div aria-label="Article preview" className="min-h-72 rounded-md border border-border-default bg-surface-card px-5 py-4">
          {value.content.length ? <HelpArticleBody doc={value} media={media} /> : <p className="text-body text-text-muted">Nothing to preview yet.</p>}
        </div>
      )}
      <div className="flex flex-wrap justify-between gap-2 text-caption text-text-muted">
        <span>
          {stats.words.toLocaleString('en-US')} words · {stats.minutes} min read · images: PNG, JPG, WebP up to 5 MB
        </span>
        <span>No scripts or embeds — text, images and links only</span>
      </div>
    </div>
  );
}
