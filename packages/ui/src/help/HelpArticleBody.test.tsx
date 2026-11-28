import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HelpArticleBody, type HelpArticleBodyDoc, type HelpArticleBodyNode } from './HelpArticleBody';
import { helpHeadingAnchor, isExternalHelpHref, isInternalHelpHref } from './helpLinks';

const p = (...content: HelpArticleBodyNode[]): HelpArticleBodyNode => ({ type: 'paragraph', content });
const t = (text: string, marks?: HelpArticleBodyNode['marks']): HelpArticleBodyNode => ({ type: 'text', text, marks });
const link = (text: string, href: string) => t(text, [{ type: 'link', attrs: { href } }]);
const doc = (...content: HelpArticleBodyNode[]): HelpArticleBodyDoc => ({ type: 'doc', content });

describe('HelpArticleBody (PHASE-8-9C P89C-5, S252)', () => {
  it('renders every block type', () => {
    render(
      <HelpArticleBody
        toc={[{ id: '1-connect' }, { id: '2-details' }]}
        media={{ m1: { status: 'ready', url: 'https://cdn.test/a.webp', width: 1600, height: 900, variants: { w640: 'https://cdn.test/a-640.webp', w1024: 'https://cdn.test/a-1024.webp' } } }}
        doc={doc(
          { type: 'heading', attrs: { level: 2 }, content: [t('Connect')] },
          p(t('Bold', [{ type: 'bold' }]), t(' and '), t('italic', [{ type: 'italic' }]), { type: 'hardBreak' }, t('under', [{ type: 'underline' }]), t('gone', [{ type: 'strike' }])),
          { type: 'heading', attrs: { level: 3 }, content: [t('Details')] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('Dot one'))] }] },
          { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('Step one'))] }, { type: 'listItem', content: [p(t('Step two'))] }] },
          { type: 'blockquote', content: [p(t('Quoted'))] },
          { type: 'callout', attrs: { tone: 'warning' }, content: [p(t('Careful'))] },
          { type: 'callout', attrs: { tone: 'tip' }, content: [p(t('Pro tip'))] },
          { type: 'image', attrs: { media_id: 'm1', alt: 'Courier settings', caption: 'Integrations › Couriers' } },
        )}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Connect' })).toHaveAttribute('id', '1-connect');
    expect(screen.getByRole('heading', { level: 3, name: 'Details' })).toHaveAttribute('id', '2-details');
    expect(screen.getByText('Bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('under').tagName).toBe('U');
    expect(screen.getByText('gone').tagName).toBe('S');
    expect(screen.getByText('Dot one').closest('ul')).not.toBeNull();
    const steps = screen.getByText('Step two').closest('ol')!;
    expect(steps.querySelectorAll('li')).toHaveLength(2);
    expect(steps).toHaveTextContent('2');
    expect(screen.getByText('Quoted').closest('blockquote')).not.toBeNull();
    expect(screen.getByRole('complementary', { name: 'Warning' })).toHaveClass('bg-warning-bg');
    expect(screen.getByRole('complementary', { name: 'Tip' })).toHaveClass('bg-success-bg');
    const img = screen.getByRole('img', { name: 'Courier settings' });
    expect(img).toHaveAttribute('src', 'https://cdn.test/a.webp');
    expect(img).toHaveAttribute('srcset', 'https://cdn.test/a-640.webp 640w, https://cdn.test/a-1024.webp 1024w');
    expect(screen.getByText('Integrations › Couriers').tagName).toBe('FIGCAPTION');
  });

  it('falls back to computed anchors and a placeholder for missing media', () => {
    render(<HelpArticleBody doc={doc({ type: 'heading', attrs: { level: 2 }, content: [t('Before you start')] }, { type: 'image', attrs: { media_id: 'nope', alt: 'Missing' } })} />);
    expect(screen.getByRole('heading', { name: 'Before you start' })).toHaveAttribute('id', '1-before-you-start');
    expect(screen.getByRole('img', { name: 'Missing' }).tagName).toBe('DIV');
    expect(helpHeadingAnchor(3, 'বুকিং ব্যর্থ হলে!')).toBe('3-বুকিং-ব্যর্থ-হলে');
  });

  it('links: external http(s) open in a new tab, internal go through the router hook', () => {
    render(
      <HelpArticleBody
        renderInternalLink={(href, children) => (
          <a data-router="yes" href={`#router${href}`}>
            {children}
          </a>
        )}
        doc={doc(p(link('Portal', 'https://portal.steadfast.com.bd'), link('Plain', 'http://example.com/x'), link('Guide', '/help/articles/steadfast')))}
      />,
    );
    const ext = screen.getByRole('link', { name: 'Portal' });
    expect(ext).toHaveAttribute('target', '_blank');
    expect(ext).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Plain' })).toHaveAttribute('href', 'http://example.com/x');
    expect(screen.getByRole('link', { name: 'Guide' })).toHaveAttribute('data-router', 'yes');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/x',
    '/\\evil.example',
    '/%2F%2Fevil.example',
    'https://user:pass@evil.example',
    'mailto:a@b.co',
    'ftp://files.example',
    'https:/missing-host',
  ])('never renders an unsafe href as a link: %s', (href) => {
    const { container } = render(<HelpArticleBody doc={doc(p(link('Click me', href)))} />);
    expect(screen.getByText('Click me')).toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
  });

  it('escapes HTML-looking text and drops unknown nodes, marks and attributes', () => {
    const { container } = render(
      <HelpArticleBody
        doc={doc(
          p(t('<img src=x onerror=alert(1)>'), t('<script>alert(1)</script>', [{ type: 'code' }, { type: 'textStyle', attrs: { style: 'color:red' } }])),
          { type: 'html', text: '<iframe src="https://evil.example"></iframe>' },
          { type: 'iframe', attrs: { src: 'https://evil.example' } },
          { type: 'paragraph', attrs: { onclick: 'alert(1)', style: 'x' }, content: [t('Safe')] },
        )}
      />,
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img, script, iframe, [onclick], [style]')).toBeNull();
    expect(container.innerHTML).not.toContain('<script');
    expect(screen.getByText('Safe')).toBeInTheDocument();
  });

  it('refuses non-http image URLs and srcset entries', () => {
    render(
      <HelpArticleBody
        media={{ m: { status: 'ready', url: 'javascript:alert(1)', width: null, height: null, variants: { w640: 'data:image/png;base64,AAAA' } } }}
        doc={doc({ type: 'image', attrs: { media_id: 'm', alt: 'Bad' } })}
      />,
    );
    expect(screen.getByRole('img', { name: 'Bad' }).tagName).toBe('DIV');
  });

  it('ignores a non-doc root and uses the Bangla typeface for bn', () => {
    const { container, rerender } = render(<HelpArticleBody doc={{ type: 'html', content: [p(t('x'))] }} />);
    expect(container.textContent).toBe('');
    rerender(<HelpArticleBody language="bn" doc={doc(p(t('বাংলা')))} />);
    expect(screen.getByTestId('help-article-body')).toHaveClass('font-bangla');
    expect(screen.getByTestId('help-article-body')).toHaveAttribute('lang', 'bn');
  });

  it('href helpers', () => {
    expect(isInternalHelpHref('/help/articles/a-b')).toBe(true);
    expect(isInternalHelpHref('//x')).toBe(false);
    expect(isExternalHelpHref('https://storeplix.com/a?b=1')).toBe(true);
    expect(isExternalHelpHref('https://exa mple.com')).toBe(false);
  });
});
