import type { HelpArticleDoc } from '@storeplix/types';
import { describe, expect, it } from 'vitest';
import { docProblems, isDocEmpty, isSafeHelpHref, missingFields, slugify, toHelpDoc, wordStats } from './doc';
import { docToMarkdown, markdownToDoc } from './markdown';

const doc: HelpArticleDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Before you start: you need a Steadfast account (2 * 3 = 6) and_this.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '1. Connect Steadfast' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'API keys' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Go to ' },
        { type: 'text', text: 'Integrations', marks: [{ type: 'bold' }] },
        { type: 'text', text: ', then ' },
        { type: 'text', text: 'Couriers', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'paste', marks: [{ type: 'underline' }] },
        { type: 'text', text: ' or ' },
        { type: 'text', text: 'type', marks: [{ type: 'strike' }] },
        { type: 'text', text: '. See ' },
        { type: 'text', text: 'the courier guide', marks: [{ type: 'link', attrs: { href: '/help/articles/couriers' } }] },
        { type: 'hardBreak' },
        { type: 'text', text: '# not a heading' },
      ],
    },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First step' }] }] }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Again' }] }] },
    { type: 'callout', attrs: { tone: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keys expire.' }] }] },
    { type: 'image', attrs: { media_id: '01HMEDIA', alt: 'Steadfast card [connected]', caption: 'The "Connected" badge' } },
    { type: 'paragraph', content: [{ type: 'text', text: 'বাংলা লেখা ঠিক থাকে।' }] },
  ],
};

describe('help article Markdown conversion', () => {
  it('round-trips every allowed block and mark', () => {
    const md = docToMarkdown(doc);
    expect(md).toContain('## 1. Connect Steadfast');
    expect(md).toContain(':::warning');
    expect(md).toContain('![Steadfast card [connected\\]](media:01HMEDIA "The \\"Connected\\" badge")');
    const back = markdownToDoc(md);
    expect(back.problems).toEqual([]);
    expect(back.doc).toEqual(doc);
  });

  it('reports unsupported syntax with line numbers instead of dropping it', () => {
    const { problems } = markdownToDoc(['# Title', '```', 'code', '```', '<script>alert(1)</script>', '| a | b |', '---', '![x](https://evil.test/a.png)', '[bad](javascript:alert(1))', '  - nested', '![](media:01H)', 'use `code`'].join('\n'));
    const byLine = Object.fromEntries(problems.map((p) => [p.line, p.message]));
    expect(byLine[1]).toMatch(/Use ## for headings/);
    expect(byLine[2]).toMatch(/Code blocks/);
    expect(byLine[5]).toMatch(/HTML isn’t allowed/);
    expect(byLine[6]).toMatch(/Tables/);
    expect(byLine[7]).toMatch(/Dividers/);
    expect(byLine[8]).toMatch(/must be uploaded/);
    expect(byLine[9]).toMatch(/isn’t allowed/);
    expect(byLine[10]).toMatch(/Nested lists/);
    expect(byLine[11]).toMatch(/alt text/);
    expect(byLine[12]).toMatch(/Code formatting/);
  });

  it('parses callouts and reports bad tones', () => {
    expect(markdownToDoc(':::tip\nHello\n\nWorld\n:::').doc.content[0]).toEqual({
      type: 'callout',
      attrs: { tone: 'tip' },
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    });
    expect(markdownToDoc(':::danger\nx\n:::').problems[0]!.message).toMatch(/:::info, :::tip or :::warning/);
    expect(markdownToDoc(':::info\nx').problems[0]!.message).toMatch(/Close the callout/);
  });
});

describe('help doc helpers', () => {
  it('toHelpDoc strips unknown nodes, unsafe links and H1', () => {
    const out = toHelpDoc({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H' }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'x()' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'code' }] }] },
        { type: 'image', attrs: { media_id: null, alt: 'x' } },
        { type: 'callout', attrs: { tone: 'evil' }, content: [] },
      ],
    });
    expect(out.content).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'x()' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      { type: 'callout', attrs: { tone: 'info' }, content: [{ type: 'paragraph' }] },
    ]);
  });

  it('safe hrefs, slugify, stats, emptiness and problems', () => {
    expect(isSafeHelpHref('/help/articles/couriers')).toBe(true);
    expect(isSafeHelpHref('https://portal.steadfast.com.bd')).toBe(true);
    expect(isSafeHelpHref('//evil.test')).toBe(false);
    expect(isSafeHelpHref('javascript:alert(1)')).toBe(false);
    expect(slugify('How to book a parcel with Steadfast!')).toBe('how-to-book-a-parcel-with-steadfast');
    expect(slugify('কুরিয়ার')).toBe('');
    expect(wordStats(doc).minutes).toBe(1);
    expect(isDocEmpty({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
    expect(missingFields({ title: 'T', summary: '', body: { type: 'doc', content: [] }, keywords: [] })).toEqual(['summary', 'body']);
    expect(docProblems({ type: 'doc', content: [{ type: 'image', attrs: { media_id: 'M', alt: ' ' } }] })).toEqual(['An image needs alt text.']);
  });
});
