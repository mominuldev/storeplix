import { describe, expect, it } from 'vitest';
import { richTextToPlain, sanitizeRichText } from './sanitize';

describe('sanitizeRichText (contract §4.4 subset)', () => {
  it('keeps allowed nodes and marks, strips attrs, drops unsafe links', () => {
    const doc = sanitizeRichText({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1, id: 'x' }, content: [{ type: 'text', text: 'Hi' }] },
        {
          type: 'paragraph',
          attrs: { textAlign: 'center' },
          content: [
            { type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)', target: '_blank' } }, { type: 'bold' }] },
            { type: 'text', text: 'good', marks: [{ type: 'link', attrs: { href: 'https://x.com', target: '_blank' } }, { type: 'code' }] },
            { type: 'hardBreak' },
            { type: 'text', text: '<script>alert(1)</script>' },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'rm -rf' }] },
        { type: 'html', content: [] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }] }] }] },
      ],
    });
    expect(doc.content[0]).toEqual({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hi' }] });
    expect(doc.content[1]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bad', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'good', marks: [{ type: 'link', attrs: { href: 'https://x.com' } }] },
        { type: 'hardBreak' },
        { type: 'text', text: '<script>alert(1)</script>' },
      ],
    });
    expect(doc.content[2]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'rm -rf' }] });
    expect(doc.content[3]).toEqual({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }] });
    expect(doc.content).toHaveLength(4);
  });

  it('handles garbage input', () => {
    expect(sanitizeRichText(null)).toEqual({ type: 'doc', content: [] });
    expect(sanitizeRichText({ content: 'x' })).toEqual({ type: 'doc', content: [] });
  });

  it('plain text', () => {
    expect(richTextToPlain(sanitizeRichText({ content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'c' }] }] }))).toBe('ab c');
  });
});
