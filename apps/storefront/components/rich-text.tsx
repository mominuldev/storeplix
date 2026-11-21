import { Fragment, type ReactNode } from 'react';
import type { RichTextBlock, RichTextDoc, RichTextInline, RichTextMark, RichTextParagraph } from '@storeplix/types';
import { isExternalHref, sanitizeRichTextHref } from '@/lib/sanitize';

/**
 * RichTextDoc → React elements (PHASE-3-CONTRACT §4.4, P3-11). Text is rendered as React text
 * (auto-escaped), unknown nodes/marks are skipped, and every link href is re-checked with
 * `sanitizeRichTextHref` (an unsafe link renders as plain text). No raw HTML, ever.
 */
function applyMarks(text: ReactNode, marks: RichTextMark[] | undefined, key: string): ReactNode {
  let out = text;
  for (const [i, m] of (marks ?? []).entries()) {
    const k = `${key}-m${i}`;
    switch (m?.type) {
      case 'bold':
        out = <strong key={k}>{out}</strong>;
        break;
      case 'italic':
        out = <em key={k}>{out}</em>;
        break;
      case 'underline':
        out = <u key={k}>{out}</u>;
        break;
      case 'strike':
        out = <s key={k}>{out}</s>;
        break;
      case 'link': {
        const href = sanitizeRichTextHref(m.attrs?.href);
        if (!href) break;
        out = isExternalHref(href) ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-2">
            {out}
          </a>
        ) : (
          <a key={k} href={href} className="text-brand underline underline-offset-2">
            {out}
          </a>
        );
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function Inline({ nodes }: { nodes: RichTextInline[] | undefined }) {
  if (!Array.isArray(nodes)) return null;
  return (
    <>
      {nodes.map((n, i) => {
        if (n?.type === 'hardBreak') return <br key={i} />;
        if (n?.type === 'text' && typeof n.text === 'string') return <Fragment key={i}>{applyMarks(n.text, n.marks, String(i))}</Fragment>;
        return null;
      })}
    </>
  );
}

const Paragraph = ({ p }: { p: RichTextParagraph }) => (
  <p>
    <Inline nodes={p.content} />
  </p>
);

function Block({ block }: { block: RichTextBlock }) {
  switch (block?.type) {
    case 'paragraph':
      return <Paragraph p={block} />;
    case 'heading':
      return block.attrs?.level === 3 ? (
        <h3>
          <Inline nodes={block.content} />
        </h3>
      ) : (
        <h2>
          <Inline nodes={block.content} />
        </h2>
      );
    case 'bulletList':
    case 'orderedList': {
      const items = (Array.isArray(block.content) ? block.content : []).map((li, i) => (
        <li key={i}>{(Array.isArray(li?.content) ? li.content : []).map((p, j) => (p?.type === 'paragraph' ? <Paragraph key={j} p={p} /> : null))}</li>
      ));
      return block.type === 'orderedList' ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'blockquote':
      return (
        <blockquote>{(Array.isArray(block.content) ? block.content : []).map((p, i) => (p?.type === 'paragraph' ? <Paragraph key={i} p={p} /> : null))}</blockquote>
      );
    default:
      return null;
  }
}

export function RichText({ doc, className = '' }: { doc: RichTextDoc | null | undefined; className?: string }) {
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content) || doc.content.length === 0) return null;
  return (
    <div className={`rich-text ${className}`}>
      {doc.content.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}
