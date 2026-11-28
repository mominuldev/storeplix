import type { RichTextDoc } from '@storeplix/types';
import { cn } from '@storeplix/ui';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Heading2, Heading3, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Underline, Unlink } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isSafeRichTextHref } from '../lib/safeHref';
import { emptyDoc, sanitizeRichText } from './sanitize';

// Tiptap restricted to the RichTextDoc subset (contract §4.4): paragraph, heading 2/3, bullet/ordered list,
// blockquote, hard break; marks bold/italic/underline/strike/link. Everything else in StarterKit is disabled,
// and every update is passed through `sanitizeRichText` before it reaches the draft. Loaded lazily.

export interface RichTextEditorProps {
  value: RichTextDoc | null;
  onChange: (doc: RichTextDoc) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

export default function RichTextEditor({ value, onChange, label, disabled = false, className }: RichTextEditorProps) {
  const lastEmitted = useRef<string>(JSON.stringify(value));
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  const editor = useEditor({
    immediatelyRender: true,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        code: false,
        codeBlock: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: false,
          defaultProtocol: 'https',
          isAllowedUri: (url) => isSafeRichTextHref(url),
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
        },
      }),
    ],
    content: value ?? emptyDoc(),
    editorProps: { attributes: { 'aria-label': label, role: 'textbox', 'aria-multiline': 'true', class: 'sp-richtext min-h-28 px-3 py-2.5 outline-none' } },
    onUpdate: ({ editor: e }) => {
      const doc = sanitizeRichText(e.getJSON());
      const json = JSON.stringify(doc);
      if (json === lastEmitted.current) return;
      lastEmitted.current = json;
      onChange(doc);
    },
  });

  useEffect(() => {
    // emitUpdate false: setEditable otherwise fires `update`, and a null value (empty description) would come back as
    // an empty doc and mark the form dirty on load (QA P89D-QA-B1).
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);

  // External changes (undo, reset to theme) replace the content without echoing back.
  useEffect(() => {
    const json = JSON.stringify(value);
    if (!editor || json === lastEmitted.current) return;
    lastEmitted.current = json;
    editor.commands.setContent(value ?? emptyDoc(), { emitUpdate: false });
  }, [editor, value]);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      underline: e?.isActive('underline') ?? false,
      strike: e?.isActive('strike') ?? false,
      h2: e?.isActive('heading', { level: 2 }) ?? false,
      h3: e?.isActive('heading', { level: 3 }) ?? false,
      bullet: e?.isActive('bulletList') ?? false,
      ordered: e?.isActive('orderedList') ?? false,
      quote: e?.isActive('blockquote') ?? false,
      link: e?.isActive('link') ?? false,
    }),
  });

  if (!editor) return null;
  const chain = () => editor.chain().focus();

  const applyLink = () => {
    const v = href.trim();
    if (!isSafeRichTextHref(v)) {
      setLinkError('Use /page, https://, mailto: or tel: links.');
      return;
    }
    chain().extendMarkRange('link').setLink({ href: v }).run();
    setLinkOpen(false);
    setHref('');
    setLinkError(null);
  };

  const btn = (key: string, title: string, icon: ReactNode, on: boolean | undefined, run: () => void) => (
    <button
      key={key}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cn('flex size-7 items-center justify-center rounded-sm text-text-secondary hover:bg-surface-subtle disabled:opacity-40 [&_svg]:size-4', on && 'bg-brand-50 text-brand-700')}
    >
      {icon}
    </button>
  );

  return (
    <div className={cn('rounded-md border border-border-strong bg-surface-card focus-within:border-brand-600', disabled && 'bg-surface-subtle', className)}>
      {!disabled && (
        <div role="toolbar" aria-label={`${label} formatting`} className="flex flex-wrap items-center gap-0.5 border-b border-border-default px-1.5 py-1">
          {btn('b', 'Bold', <Bold />, active?.bold, () => chain().toggleBold().run())}
          {btn('i', 'Italic', <Italic />, active?.italic, () => chain().toggleItalic().run())}
          {btn('u', 'Underline', <Underline />, active?.underline, () => chain().toggleUnderline().run())}
          {btn('s', 'Strikethrough', <Strikethrough />, active?.strike, () => chain().toggleStrike().run())}
          <span aria-hidden className="mx-1 h-4 w-px bg-border-default" />
          {btn('h2', 'Heading', <Heading2 />, active?.h2, () => chain().toggleHeading({ level: 2 }).run())}
          {btn('h3', 'Subheading', <Heading3 />, active?.h3, () => chain().toggleHeading({ level: 3 }).run())}
          {btn('ul', 'Bulleted list', <List />, active?.bullet, () => chain().toggleBulletList().run())}
          {btn('ol', 'Numbered list', <ListOrdered />, active?.ordered, () => chain().toggleOrderedList().run())}
          {btn('q', 'Quote', <Quote />, active?.quote, () => chain().toggleBlockquote().run())}
          <span aria-hidden className="mx-1 h-4 w-px bg-border-default" />
          {btn('a', 'Add link', <Link2 />, active?.link, () => {
            setHref((editor.getAttributes('link').href as string | undefined) ?? '');
            setLinkError(null);
            setLinkOpen((o) => !o);
          })}
          {active?.link && btn('ua', 'Remove link', <Unlink />, false, () => chain().extendMarkRange('link').unsetLink().run())}
        </div>
      )}
      {linkOpen && (
        <div className="flex flex-col gap-1 border-b border-border-default p-2">
          <div className="flex gap-1.5">
            <input
              autoFocus
              aria-label="Link address"
              placeholder="/pages/contact or https://…"
              value={href}
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyLink();
                }
              }}
              className="min-w-0 flex-1 rounded-sm border border-border-strong px-2 py-1 text-[13px] outline-none focus:border-brand-600"
            />
            <button type="button" onClick={applyLink} className="rounded-sm bg-brand-600 px-2.5 text-caption font-medium text-text-inverse">
              Apply
            </button>
          </div>
          {linkError && <p className="text-caption text-danger">{linkError}</p>}
        </div>
      )}
      <EditorContent editor={editor} className="text-[13px] leading-[19px] text-text-primary" />
    </div>
  );
}
