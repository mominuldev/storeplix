import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RichTextDoc } from '@storeplix/types';
import { RichText } from '@/components/rich-text';
import { PageBlocks } from '@/components/page-blocks';
import { normalizeRichText } from '@/lib/rich-text';
import { parsePageBlocks } from '@/lib/page-blocks';
import { sanitizeRichTextHref } from '@/lib/sanitize';

const render = (doc: unknown) => renderToStaticMarkup(createElement(RichText, { doc: doc as RichTextDoc }));
const para = (...content: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });
const link = (href: string) => para({ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href } }] });

describe('RichText renderer', () => {
  it('renders script-looking text as escaped text', () => {
    const html = render(para({ type: 'text', text: '<script>alert(1)</script><img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders every supported node and mark', () => {
    const html = render({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H2' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'H3' }] },
        para({ type: 'text', text: 'b', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }] }, { type: 'hardBreak' }).content[0],
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quote' }] }] },
      ],
    });
    expect(html).toContain('<h2>H2</h2>');
    expect(html).toContain('<h3>H3</h3>');
    expect(html).toContain('<s><u><em><strong>b</strong></em></u></s>');
    expect(html).toContain('<br/>');
    expect(html).toMatch(/<ul><li><p>.*one.*<\/p><\/li><\/ul>/);
    expect(html).toMatch(/<ol><li>/);
    expect(html).toContain('<blockquote>');
  });

  it('skips unknown nodes and marks', () => {
    const html = render({ type: 'doc', content: [{ type: 'html', content: '<b>x</b>' }, para({ type: 'text', text: 'ok', marks: [{ type: 'script' }] }).content[0], { type: 'iframe' }] });
    expect(html).toBe('<div class="rich-text "><p>ok</p></div>');
  });

  it.each([
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    '%6a%61vascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.com',
    '/\\evil.com',
    'https://user:pw@x.com',
    'mailto:a@b.com?bcc=c@d.com',
    'tel:12',
    'vbscript:msgbox(1)',
  ])('drops the link for %j but keeps the text', (href) => {
    const html = render(link(href));
    expect(html).not.toContain('<a');
    expect(html).toContain('click');
  });

  it('renders safe links; external ones get rel="noopener noreferrer"', () => {
    expect(render(link('/pages/about'))).toContain('<a href="/pages/about" class=');
    expect(render(link('mailto:hi@shop.com'))).toContain('href="mailto:hi@shop.com"');
    expect(render(link('tel:+8801700000000'))).toContain('href="tel:+8801700000000"');
    const ext = render(link('https://example.com/x'));
    expect(ext).toContain('href="https://example.com/x" target="_blank" rel="noopener noreferrer"');
    expect(render(link('http://example.com/'))).toContain('rel="noopener noreferrer"');
  });

  it('normalizeRichText reports what it dropped', () => {
    expect(normalizeRichText(para({ type: 'text', text: 'fine' })).dropped).toBe(false);
    expect(normalizeRichText(link('javascript:x')).dropped).toBe(true);
    expect(normalizeRichText({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList' }] }] }] }).dropped).toBe(true);
    expect(sanitizeRichTextHref('mailto:a@b.co')).toBe('mailto:a@b.co');
  });
});

describe('PageBlocks renderer', () => {
  const media = { '01jcz8m4q9w7t3x5y6z8a0b2c4': { id: '01jcz8m4q9w7t3x5y6z8a0b2c4', url: 'https://cdn.storeplix.com/a.webp', width: 800, height: 600, alt: 'A', srcset: [] } };

  it('renders each block type from validated data and drops invalid blocks', () => {
    const blocks = parsePageBlocks([
      { id: 'blk00001', type: 'heading', text: 'Delivery <b>', level: 2 },
      { id: 'blk00002', type: 'rich_text', doc: para({ type: 'text', text: 'Body' }) },
      { id: 'blk00003', type: 'image', media_id: '01jcz8m4q9w7t3x5y6z8a0b2c4', alt: null, caption: 'Cap' },
      { id: 'blk00004', type: 'image', media_id: '01jcz8m4q9w7t3x5y6z8a0b2c5', alt: null, caption: null },
      { id: 'blk00005', type: 'button', label: 'WhatsApp us', href: 'https://wa.me/8801700000000', style: 'primary' },
      { id: 'blk00006', type: 'button', label: 'Bad', href: 'javascript:alert(1)', style: 'primary' },
      { id: 'blk00007', type: 'callout', title: 'Note', items: ['One', 'Two'], tone: 'warning' },
      { id: 'blk00008', type: 'table', headers: ['Area', 'Charge'], rows: [['Dhaka', '৳70'], ['Outside', '৳130']] },
      { id: 'blk00009', type: 'table', headers: ['A'], rows: [['1', '2']] },
      { id: 'blk00010', type: 'html', html: '<script>alert(1)</script>' },
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'rich_text', 'image', 'image', 'button', 'callout', 'table']);
    const html = renderToStaticMarkup(createElement(PageBlocks, { blocks, media }));
    expect(html).toMatch(/<h2 id="section-[A-Za-z0-9_-]+" class="type-h2[^"]*">Delivery &lt;b&gt;<\/h2>/);
    expect(html).toContain('Body');
    expect(html).toContain('Cap');
    expect(html.match(/<figure/g)).toHaveLength(1); // unresolved media → block omitted
    expect(html).toContain('href="https://wa.me/8801700000000" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
    expect(html).toContain('<th scope="col" class="px-4 py-3 font-semibold">Charge</th>');
  });
});

describe('no raw HTML anywhere in the storefront', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'tests', '.next', 'public'].includes(name) || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(p)) out.push(p);
    }
    return out;
  }
  it('no source file uses dangerouslySetInnerHTML (lint rule + grep)', () => {
    const offenders = walk(join(__dirname, '..')).filter((f) => readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML'));
    expect(offenders).toEqual([]);
  });
});
