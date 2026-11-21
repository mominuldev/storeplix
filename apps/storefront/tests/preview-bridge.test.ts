import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptEditorMessage, previewMessage, referrerTargetOrigin } from '@/lib/editor-bridge';

const ALLOWED = ['http://localhost:5173', 'https://app.storeplix.com'];
const parent = { name: 'parent-window' };
const refresh = { source: 'storeplix-editor', v: 1, type: 'refresh' };

describe('PreviewBridge: incoming messages', () => {
  it('accepts a valid message from the parent window on an allowlisted origin', () => {
    expect(acceptEditorMessage({ origin: 'http://localhost:5173', source: parent, data: refresh }, parent, ALLOWED)).toEqual(refresh);
    const select = { source: 'storeplix-editor', v: 1, type: 'select', section_id: 'h3ro0001' };
    expect(acceptEditorMessage({ origin: 'https://app.storeplix.com', source: parent, data: select }, parent, ALLOWED)).toEqual(select);
    expect(acceptEditorMessage({ origin: 'https://app.storeplix.com', source: parent, data: { ...select, section_id: null } }, parent, ALLOWED)).not.toBeNull();
  });

  it.each([
    ['wrong origin', { origin: 'https://evil.com', source: parent, data: refresh }],
    ['origin prefix trick', { origin: 'http://localhost:51730', source: parent, data: refresh }],
    ['null origin', { origin: 'null', source: parent, data: refresh }],
    ['wrong source window', { origin: 'http://localhost:5173', source: {}, data: refresh }],
    ['malformed data', { origin: 'http://localhost:5173', source: parent, data: 'refresh' }],
    ['wrong protocol version', { origin: 'http://localhost:5173', source: parent, data: { ...refresh, v: 2 } }],
    ['spoofed source tag', { origin: 'http://localhost:5173', source: parent, data: { ...refresh, source: 'storeplix-preview' } }],
    ['extra keys', { origin: 'http://localhost:5173', source: parent, data: { ...refresh, token: 'x' } }],
    ['bad section id', { origin: 'http://localhost:5173', source: parent, data: { source: 'storeplix-editor', v: 1, type: 'scroll-to', section_id: '"]<x>' } }],
  ])('ignores %s', (_label, event) => {
    expect(acceptEditorMessage(event, parent, ALLOWED)).toBeNull();
  });

  it('ignores everything when not framed or no origins are configured', () => {
    expect(acceptEditorMessage({ origin: 'http://localhost:5173', source: null, data: refresh }, null, ALLOWED)).toBeNull();
    expect(acceptEditorMessage({ origin: 'http://localhost:5173', source: parent, data: refresh }, parent, [])).toBeNull();
  });
});

describe('PreviewBridge: outgoing messages', () => {
  it('posts only to the exact origin of an allowlisted referrer', () => {
    expect(referrerTargetOrigin('http://localhost:5173/', ALLOWED)).toBe('http://localhost:5173');
    expect(referrerTargetOrigin('https://app.storeplix.com/online-store/editor?page=home', ALLOWED)).toBe('https://app.storeplix.com');
    expect(referrerTargetOrigin('https://evil.com/', ALLOWED)).toBeNull();
    expect(referrerTargetOrigin('', ALLOWED)).toBeNull();
    expect(referrerTargetOrigin('not a url', ALLOWED)).toBeNull();
  });

  it('builds protocol messages without secrets', () => {
    expect(previewMessage({ type: 'ready', path: '/' })).toEqual({ source: 'storeplix-preview', v: 1, type: 'ready', path: '/' });
    expect(previewMessage({ type: 'section-click', section_id: 'h3ro0001' })).toEqual({ source: 'storeplix-preview', v: 1, type: 'section-click', section_id: 'h3ro0001' });
  });

  it('the bridge never uses a wildcard targetOrigin', () => {
    const src = readFileSync(join(__dirname, '../components/preview-bridge.tsx'), 'utf8');
    expect(src).not.toMatch(/postMessage\([^)]*['"]\*['"]/);
    expect(src).toContain('target.current');
  });
});
