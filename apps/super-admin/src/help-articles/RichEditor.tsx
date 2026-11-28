import type { HelpArticleDoc, HelpMediaRef } from '@storeplix/types';
import { cn } from '@storeplix/ui';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, MessageSquareWarning, Unlink } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { editableDoc, isSafeHelpHref, toHelpDoc } from './doc';
import { HelpCallout, HelpImage, HelpMediaContext } from './editorNodes';
import { ImageUploadDialog } from './ImageUploadDialog';

// Write mode (PHASE-8-9C §14): Tiptap restricted to the HelpArticleDoc nodes — StarterKit minus code, code block,
// horizontal rule and H1/H4+, plus our image + callout nodes. Every update goes through `toHelpDoc` before it reaches
// the draft. Toolbar from 2134:66712: H2 H3 B I • List 1. Steps Link Image Callout. Loaded lazily.

export interface RichEditorProps {
  value: HelpArticleDoc;
  onChange: (doc: HelpArticleDoc) => void;
  media: Record<string, HelpMediaRef>;
  onMediaAdded: (ref: HelpMediaRef) => void;
  label: string;
  disabled?: boolean;
}

export default function RichEditor({ value, onChange, media, onMediaAdded, label, disabled = false }: RichEditorProps) {
  const lastEmitted = useRef<string>(JSON.stringify(value));
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [imageOpen, setImageOpen] = useState(false);

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
          isAllowedUri: (url) => isSafeHelpHref(url),
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
        },
      }),
      HelpImage,
      HelpCallout,
    ],
    content: editableDoc(value),
    editorProps: { attributes: { 'aria-label': label, role: 'textbox', 'aria-multiline': 'true', class: 'sp-helpdoc min-h-72 px-4 py-3 outline-none' } },
    onUpdate: ({ editor: e }) => {
      const doc = toHelpDoc(e.getJSON());
      const json = JSON.stringify(doc);
      if (json === lastEmitted.current) return;
      lastEmitted.current = json;
      onChange(doc);
    },
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // External changes (language switch, Markdown edits, reload after a conflict) replace the content without echoing.
  useEffect(() => {
    const json = JSON.stringify(value);
    if (!editor || json === lastEmitted.current) return;
    lastEmitted.current = json;
    editor.commands.setContent(editableDoc(value), { emitUpdate: false });
  }, [editor, value]);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      h2: e?.isActive('heading', { level: 2 }) ?? false,
      h3: e?.isActive('heading', { level: 3 }) ?? false,
      bullet: e?.isActive('bulletList') ?? false,
      ordered: e?.isActive('orderedList') ?? false,
      callout: e?.isActive('callout') ?? false,
      link: e?.isActive('link') ?? false,
    }),
  });

  if (!editor) return null;
  const chain = () => editor.chain().focus();

  const applyLink = () => {
    const v = href.trim();
    if (!isSafeHelpHref(v)) {
      setLinkError('Use /help/articles/…, https://, mailto: or tel: links.');
      return;
    }
    chain().extendMarkRange('link').setLink({ href: v }).run();
    setLinkOpen(false);
    setHref('');
    setLinkError(null);
  };

  const toggleCallout = () => {
    if (editor.isActive('callout')) chain().lift('callout').run();
    else if (!chain().wrapIn('callout', { tone: 'info' }).run()) {
      chain().insertContent({ type: 'callout', attrs: { tone: 'info' }, content: [{ type: 'paragraph' }] }).run();
    }
  };

  const btn = (key: string, title: string, content: ReactNode, on: boolean | undefined, run: () => void) => (
    <button
      key={key}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cn(
        'flex h-7 min-w-7 items-center justify-center gap-1 rounded-sm px-1.5 text-caption font-medium text-text-secondary hover:bg-surface-card disabled:opacity-40 [&_svg]:size-4',
        on && 'bg-surface-card text-brand-700 shadow-elevation-1',
      )}
    >
      {content}
    </button>
  );

  return (
    <HelpMediaContext value={media}>
      <div className={cn('rounded-md border border-border-default bg-surface-card focus-within:border-brand-600', disabled && 'bg-surface-subtle')}>
        {!disabled && (
          <div role="toolbar" aria-label={`${label} formatting`} className="flex flex-wrap items-center gap-0.5 rounded-t-md border-b border-border-default bg-surface-subtle px-1.5 py-1">
            {btn('h2', 'Heading', <Heading2 />, active?.h2, () => chain().toggleHeading({ level: 2 }).run())}
            {btn('h3', 'Subheading', <Heading3 />, active?.h3, () => chain().toggleHeading({ level: 3 }).run())}
            {btn('b', 'Bold', <Bold />, active?.bold, () => chain().toggleBold().run())}
            {btn('i', 'Italic', <Italic />, active?.italic, () => chain().toggleItalic().run())}
            {btn('ul', 'Bulleted list', <List />, active?.bullet, () => chain().toggleBulletList().run())}
            {btn('ol', 'Numbered steps', <ListOrdered />, active?.ordered, () => chain().toggleOrderedList().run())}
            {btn('a', 'Add link', <Link2 />, active?.link, () => {
              setHref((editor.getAttributes('link').href as string | undefined) ?? '');
              setLinkError(null);
              setLinkOpen((o) => !o);
            })}
            {active?.link && btn('ua', 'Remove link', <Unlink />, false, () => chain().extendMarkRange('link').unsetLink().run())}
            {btn('img', 'Insert image', <ImagePlus />, false, () => setImageOpen(true))}
            {btn('callout', 'Callout', <MessageSquareWarning />, active?.callout, toggleCallout)}
          </div>
        )}
        {linkOpen && (
          <div className="flex flex-col gap-1 border-b border-border-default p-2">
            <div className="flex gap-1.5">
              <input
                autoFocus
                aria-label="Link address"
                placeholder="/help/articles/… or https://…"
                value={href}
                onChange={(e) => setHref(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyLink();
                  }
                }}
                className="min-w-0 flex-1 rounded-sm border border-border-strong px-2 py-1 text-body outline-none focus:border-brand-600"
              />
              <button type="button" onClick={applyLink} className="rounded-sm bg-brand-600 px-2.5 text-caption font-medium text-text-inverse">
                Apply
              </button>
            </div>
            {linkError && <p className="text-caption text-danger">{linkError}</p>}
          </div>
        )}
        <EditorContent editor={editor} className="text-body text-text-primary" />
      </div>
      {imageOpen && (
        <ImageUploadDialog
          onClose={() => setImageOpen(false)}
          onInserted={(ref, alt, caption) => {
            onMediaAdded(ref);
            setImageOpen(false);
            chain()
              .insertContent({ type: 'image', attrs: { media_id: ref.id, alt, caption: caption || null } })
              .run();
          }}
        />
      )}
    </HelpMediaContext>
  );
}
