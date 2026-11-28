import type { HelpArticleBlock, HelpArticleDoc, HelpCalloutTone, RichTextInline, RichTextMark, RichTextParagraph } from '@storeplix/types';
import { CALLOUT_TONES, isSafeHelpHref, normalizeInlines } from './doc';

// PHASE-8-9C §14 Markdown mode: a textarea view of the same `HelpArticleDoc`. Markdown lives only in the editor — the
// API never receives it. Only the syntax below converts; anything else is reported with its line and the text is kept
// in Markdown mode until it is fixed (nothing is silently dropped).
//
//   ## Heading · ### Subheading · - bullet · 1. step · > quote · blank line = new paragraph · trailing \ = line break
//   **bold** · *italic* · ++underline++ · ~~strike~~ · [text](/help/articles/slug or https://…)
//   ![alt text](media:MEDIA_ID "optional caption")      (upload images with the Image button)
//   :::tip / :::info / :::warning … :::                 (callout)

export interface MarkdownProblem {
  line: number;
  message: string;
}
export interface MarkdownResult {
  doc: HelpArticleDoc;
  problems: MarkdownProblem[];
}

// ---------- doc → Markdown ----------

const INLINE_ESCAPES = /[\\*_[\]`<]/g;

function escapeText(text: string): string {
  return text.replace(INLINE_ESCAPES, (c) => `\\${c}`).replace(/~~/g, '\\~\\~').replace(/\+\+/g, '\\+\\+');
}

function wrap(text: string, marks: RichTextMark[] | undefined): string {
  let out = escapeText(text);
  const types = new Set((marks ?? []).map((m) => m.type));
  if (types.has('strike')) out = `~~${out}~~`;
  if (types.has('underline')) out = `++${out}++`;
  if (types.has('italic')) out = `*${out}*`;
  if (types.has('bold')) out = `**${out}**`;
  const link = marks?.find((m): m is Extract<RichTextMark, { type: 'link' }> => m.type === 'link');
  if (link) out = `[${out}](${link.attrs.href})`;
  return out;
}

function inlineToMd(nodes: RichTextInline[] | undefined): string {
  const merged = normalizeInlines(nodes ?? []);
  // A link spanning differently formatted runs is written once around the whole run.
  let out = '';
  for (let i = 0; i < merged.length; i++) {
    const n = merged[i]!;
    if (n.type === 'hardBreak') {
      out += '\\\n';
      continue;
    }
    const link = n.marks?.find((m) => m.type === 'link');
    if (!link) {
      out += wrap(n.text, n.marks);
      continue;
    }
    const href = (link as Extract<RichTextMark, { type: 'link' }>).attrs.href;
    let inner = '';
    let j = i;
    for (; j < merged.length; j++) {
      const m = merged[j]!;
      const l = m.type === 'text' ? m.marks?.find((x) => x.type === 'link') : undefined;
      if (m.type !== 'text' || !l || (l as Extract<RichTextMark, { type: 'link' }>).attrs.href !== href) break;
      inner += wrap(m.text, m.marks?.filter((x) => x.type !== 'link'));
    }
    out += `[${inner}](${href})`;
    i = j - 1;
  }
  return out;
}

/** Escapes characters that would start a block when a paragraph line begins with them. */
function guardLineStart(line: string): string {
  if (/^(#|>|[-*+] |:::|!\[)/.test(line)) return `\\${line}`;
  const ordered = /^(\d+)\. /.exec(line);
  if (ordered) return `${ordered[1]}\\. ${line.slice(ordered[0].length)}`;
  return line;
}

function paragraphToMd(p: RichTextParagraph): string {
  return inlineToMd(p.content)
    .split('\n')
    .map((l) => guardLineStart(l))
    .join('\n');
}

function blockToMd(b: HelpArticleBlock): string {
  switch (b.type) {
    case 'paragraph':
      return paragraphToMd(b);
    case 'heading':
      return `${b.attrs.level === 2 ? '##' : '###'} ${inlineToMd(b.content)}`;
    case 'bulletList':
      return b.content.map((li) => `- ${li.content.map((p) => inlineToMd(p.content)).join(' ')}`).join('\n');
    case 'orderedList':
      return b.content.map((li, i) => `${i + 1}. ${li.content.map((p) => inlineToMd(p.content)).join(' ')}`).join('\n');
    case 'blockquote':
      return b.content.map((p) => paragraphToMd(p).split('\n').map((l) => `> ${l}`).join('\n')).join('\n>\n');
    case 'callout':
      return [`:::${b.attrs.tone}`, b.content.map(paragraphToMd).join('\n\n'), ':::'].join('\n');
    case 'image': {
      const alt = b.attrs.alt.replace(/[\\\]]/g, (c) => `\\${c}`);
      const caption = b.attrs.caption ? ` "${b.attrs.caption.replace(/[\\"]/g, (c) => `\\${c}`)}"` : '';
      return `![${alt}](media:${b.attrs.media_id}${caption})`;
    }
  }
}

export function docToMarkdown(doc: HelpArticleDoc): string {
  return doc.content
    .filter((b) => !(b.type === 'paragraph' && !b.content?.length))
    .map(blockToMd)
    .join('\n\n');
}

// ---------- Markdown → doc ----------

interface InlineCtx {
  line: number;
  problems: MarkdownProblem[];
}

const ESCAPABLE = new Set(['\\', '*', '_', '[', ']', '`', '<', '~', '+', '#', '>', '-', '!', ':', '.', '"', '(', ')']);

function addMark(marks: RichTextMark[], mark: RichTextMark): RichTextMark[] {
  return marks.some((m) => m.type === mark.type) ? marks : [...marks, mark];
}

/** Finds the closing delimiter, skipping escaped characters. */
function findClose(s: string, from: number, delim: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s.startsWith(delim, i)) {
      // `*` italic must not close on `**`.
      if (delim === '*' && s[i + 1] === '*') {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function parseInline(s: string, marks: RichTextMark[], ctx: InlineCtx): RichTextInline[] {
  const out: RichTextInline[] = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    out.push(marks.length ? { type: 'text', text: buf, marks: [...marks] } : { type: 'text', text: buf });
    buf = '';
  };
  const pairs: [string, RichTextMark['type']][] = [
    ['**', 'bold'],
    ['~~', 'strike'],
    ['++', 'underline'],
    ['*', 'italic'],
    ['_', 'italic'],
  ];
  let i = 0;
  outer: while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      const next = s[i + 1];
      if (next === undefined) {
        i++;
        continue;
      }
      if (next === '\n') {
        flush();
        out.push({ type: 'hardBreak' });
        i += 2;
        continue;
      }
      if (ESCAPABLE.has(next)) {
        buf += next;
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '\n') {
      buf += ' ';
      i++;
      continue;
    }
    for (const [delim, type] of pairs) {
      if (s.startsWith(delim, i)) {
        const close = findClose(s, i + delim.length, delim);
        if (close > i + delim.length) {
          flush();
          out.push(...parseInline(s.slice(i + delim.length, close), addMark(marks, { type } as RichTextMark), ctx));
          i = close + delim.length;
          continue outer;
        }
      }
    }
    if (c === '[') {
      const closeText = findClose(s, i + 1, ']');
      if (closeText > i && s[closeText + 1] === '(') {
        const closeHref = s.indexOf(')', closeText + 2);
        if (closeHref > 0) {
          const href = s.slice(closeText + 2, closeHref).trim();
          if (!isSafeHelpHref(href)) {
            ctx.problems.push({ line: ctx.line, message: `Link “${href}” isn’t allowed. Use /help/articles/…, https://, mailto: or tel: links.` });
          } else {
            flush();
            out.push(...parseInline(s.slice(i + 1, closeText), addMark(marks, { type: 'link', attrs: { href } }), ctx));
          }
          i = closeHref + 1;
          continue;
        }
      }
    }
    if (c === '`') {
      ctx.problems.push({ line: ctx.line, message: 'Code formatting isn’t supported. Remove the backticks.' });
      i++;
      continue;
    }
    if (c === '<' && /^<\/?[a-z!]/i.test(s.slice(i))) {
      ctx.problems.push({ line: ctx.line, message: 'HTML isn’t allowed in help articles. Use the toolbar formatting instead.' });
      const end = s.indexOf('>', i);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      ctx.problems.push({ line: ctx.line, message: 'Put images on their own line.' });
    }
    buf += c;
    i++;
  }
  flush();
  return normalizeInlines(out);
}

const IMAGE_LINE = /^!\[((?:[^\]\\]|\\.)*)\]\(([^)\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\)$/;
const unescape = (s: string) => s.replace(/\\(.)/g, '$1');

export function markdownToDoc(markdown: string): MarkdownResult {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const problems: MarkdownProblem[] = [];
  const blocks: HelpArticleBlock[] = [];

  const inline = (text: string, line: number) => parseInline(text, [], { line, problems });
  const para = (text: string, line: number): RichTextParagraph => {
    const content = inline(text, line);
    return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
  };

  /** Parses paragraphs (blank-line separated) of a callout body. */
  const paragraphsOf = (chunk: { text: string; line: number }[]): RichTextParagraph[] => {
    const out: RichTextParagraph[] = [];
    let cur: { text: string; line: number }[] = [];
    const end = () => {
      if (cur.length) out.push(para(cur.map((c) => c.text).join('\n'), cur[0]!.line));
      cur = [];
    };
    for (const c of chunk) {
      if (!c.text.trim()) end();
      else {
        if (/^(#{1,6} |[-*+] |\d+\. |> |!\[)/.test(c.text)) problems.push({ line: c.line, message: 'A callout can only hold plain paragraphs.' });
        cur.push(c);
      }
    }
    end();
    return out;
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s+\S/.test(raw) && /^\s+([-*+]|\d+\.) /.test(raw)) {
      problems.push({ line: lineNo, message: 'Nested lists aren’t supported. Keep every item at the start of the line.' });
      i++;
      continue;
    }
    if (/^```|^~~~/.test(line)) {
      problems.push({ line: lineNo, message: 'Code blocks aren’t supported in help articles.' });
      i++;
      while (i < lines.length && !/^```|^~~~/.test(lines[i]!)) i++;
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      problems.push({ line: lineNo, message: 'Dividers (---) aren’t supported. Use a heading instead.' });
      i++;
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      problems.push({ line: lineNo, message: 'Tables aren’t supported. Use a list instead.' });
      i++;
      continue;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (level !== 2 && level !== 3) {
        problems.push({ line: lineNo, message: level === 1 ? 'Use ## for headings — the article title is the only top heading.' : 'Only ## and ### headings are supported.' });
      } else {
        const content = inline(heading[2]!.trim(), lineNo);
        blocks.push(content.length ? { type: 'heading', attrs: { level }, content } : { type: 'heading', attrs: { level } });
      }
      i++;
      continue;
    }
    const callout = /^:::\s*(\w*)\s*$/.exec(line);
    if (callout) {
      const tone = CALLOUT_TONES.find((t) => t === callout[1]) as HelpCalloutTone | undefined;
      if (!tone) problems.push({ line: lineNo, message: 'Callouts start with :::info, :::tip or :::warning.' });
      const body: { text: string; line: number }[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (/^:::\s*$/.test(lines[i]!.trim())) {
          closed = true;
          i++;
          break;
        }
        body.push({ text: lines[i]!.replace(/\s+$/, ''), line: i + 1 });
        i++;
      }
      if (!closed) problems.push({ line: lineNo, message: 'Close the callout with a line that has only :::' });
      const content = paragraphsOf(body);
      blocks.push({ type: 'callout', attrs: { tone: tone ?? 'info' }, content: content.length ? content : [{ type: 'paragraph' }] });
      continue;
    }
    if (line.startsWith('![')) {
      const m = IMAGE_LINE.exec(line.trim());
      const src = m?.[2] ?? '';
      if (!m) problems.push({ line: lineNo, message: 'Write images as ![alt text](media:ID "caption").' });
      else if (!src.startsWith('media:') || src.length <= 6) {
        problems.push({ line: lineNo, message: 'Images must be uploaded with the Image button; outside image links aren’t allowed.' });
      } else {
        const alt = unescape(m[1]!).trim();
        if (!alt) problems.push({ line: lineNo, message: 'This image needs alt text: ![describe the image](…).' });
        const caption = m[3] ? unescape(m[3]).trim() : '';
        const mediaId = src.slice(6);
        blocks.push({ type: 'image', attrs: caption ? { media_id: mediaId, alt, caption } : { media_id: mediaId, alt } });
      }
      i++;
      continue;
    }
    const bullet = /^[-*+] (.*)$/;
    const ordered = /^\d+\. (.*)$/;
    for (const [re, type] of [
      [bullet, 'bulletList'],
      [ordered, 'orderedList'],
    ] as const) {
      if (re.test(line)) {
        const items: { type: 'listItem'; content: RichTextParagraph[] }[] = [];
        while (i < lines.length && re.test(lines[i]!.replace(/\s+$/, ''))) {
          const text = re.exec(lines[i]!.replace(/\s+$/, ''))![1]!;
          items.push({ type: 'listItem', content: [para(text, i + 1)] });
          i++;
        }
        blocks.push({ type, content: items });
        break;
      }
    }
    if (bullet.test(line) || ordered.test(line)) continue;
    if (/^>/.test(line)) {
      const body: { text: string; line: number }[] = [];
      while (i < lines.length && /^>/.test(lines[i]!)) {
        body.push({ text: lines[i]!.replace(/^> ?/, '').replace(/\s+$/, ''), line: i + 1 });
        i++;
      }
      const content = paragraphsOf(body);
      if (content.length) blocks.push({ type: 'blockquote', content });
      continue;
    }
    // Paragraph: consecutive lines until a blank line or a block start.
    const start = i;
    const text: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!.replace(/\s+$/, '');
      if (!l.trim()) break;
      if (i > start && /^(#{1,6} |[-*+] |\d+\. |>|:::|!\[|```|~~~|\|.*\|$|-{3,}$|\*{3,}$|_{3,}$|\s+([-*+]|\d+\.) )/.test(l)) break;
      text.push(l);
      i++;
    }
    blocks.push(para(text.join('\n'), start + 1));
  }
  const seen = new Set<string>();
  const unique = problems.filter((p) => !seen.has(`${p.line}:${p.message}`) && !!seen.add(`${p.line}:${p.message}`));
  return { doc: { type: 'doc', content: blocks }, problems: unique };
}
