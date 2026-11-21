import { ApiError } from '@storeplix/api-client';
import type { ThemeConfig } from '@storeplix/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '../theme-package/modern-commerce';
import { AutosaveController, type AutosaveStatus } from './autosave';
import { postToPreview, previewOriginOf, readPreviewMessage } from './bridge';
import { countChanges, summarizeChanges } from './changes';
import { addBlockedReason, editorReducer, HISTORY_LIMIT, initEditor, visibilityOf, type EditorAction, type EditorState } from './editorReducer';
import { toDotPath, validateThemeConfig } from './validate';

const clone = (): ThemeConfig => structuredClone(defaults);
const run = (state: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, state);
const ids = (s: EditorState) => s.config.sections.map((x) => x.id);

describe('editorReducer', () => {
  it('reorders by drag index and by keyboard (moveBy)', () => {
    const s0 = initEditor(clone());
    const [a, b, c] = ids(s0);
    const s1 = run(s0, { type: 'move', from: 0, to: 2 });
    expect(ids(s1).slice(0, 3)).toEqual([b, c, a]);
    const s2 = run(s1, { type: 'moveBy', id: a!, delta: -1 });
    expect(ids(s2).slice(0, 3)).toEqual([b, a, c]);
    // Out of range is a no-op (no history entry).
    const s3 = run(s0, { type: 'moveBy', id: a!, delta: -1 });
    expect(s3.config).toBe(s0.config);
  });

  it('toggles enabled and sets per-device visibility', () => {
    const s0 = initEditor(clone());
    const id = ids(s0)[1]!;
    const s1 = run(s0, { type: 'toggle', id }, { type: 'setVisibility', id, device: 'phone', value: false });
    const section = s1.config.sections[1]!;
    expect(section.enabled).toBe(false);
    expect(visibilityOf(section)).toEqual({ desktop: true, tablet: true, phone: false });
  });

  it('respects maxInstances (hero once) and the 30-section limit', () => {
    const s0 = initEditor(clone());
    const s1 = run(s0, { type: 'add', sectionType: 'hero' });
    expect(s1.config.sections).toHaveLength(s0.config.sections.length);
    expect(s1.notice).toBe('Hero can only be added once.');
    expect(addBlockedReason(s0.config, 'hero')).not.toBeNull();
    expect(addBlockedReason(s0.config, 'rich-text')).toBeNull();

    let s = initEditor({ ...clone(), sections: [] });
    for (let i = 0; i < 40; i++) s = run(s, { type: 'add', sectionType: ['rich-text', 'chip-links', 'category-grid', 'feature-tiles', 'image-with-text', 'featured-products', 'trust-badges', 'hero', 'flash-sale', 'reviews-club'][i % 10]! });
    // 5 + 3*5 + 2 + 1*3 = 25 is the instance cap for this mix; never above 30.
    expect(s.config.sections.length).toBeLessThanOrEqual(30);
    const many = { ...clone(), sections: Array.from({ length: 30 }, (_, i) => ({ id: `rich${String(i).padStart(6, '0')}`, type: 'rich-text', enabled: true, settings: {} })) };
    const full = run(initEditor(many), { type: 'add', sectionType: 'rich-text' });
    expect(full.config.sections).toHaveLength(30);
    expect(full.notice).toBe('A page can have up to 30 sections.');
  });

  it('duplicates with fresh unique ids for the section and its blocks', () => {
    const s0 = initEditor(clone());
    const src = s0.config.sections.find((x) => x.type === 'chip-links')!;
    const s1 = run(s0, { type: 'duplicate', id: src.id });
    const i = s1.config.sections.findIndex((x) => x.id === src.id);
    const copy = s1.config.sections[i + 1]!;
    expect(copy.type).toBe('chip-links');
    expect(copy.id).not.toBe(src.id);
    expect(copy.id).toMatch(/^[a-z0-9]{8,16}$/);
    const all = s1.config.sections.flatMap((x) => [x.id, ...(x.blocks ?? []).map((b) => b.id)]);
    expect(new Set(all).size).toBe(all.length);
    expect(s1.selectedId).toBe(copy.id);
    // Duplicating a once-only section is blocked.
    expect(run(s0, { type: 'duplicate', id: ids(s0)[0]! }).notice).toMatch(/once/);
  });

  it('removes and keeps a sensible selection', () => {
    const s0 = initEditor(clone());
    const s1 = run(s0, { type: 'select', id: ids(s0)[2]! }, { type: 'remove', id: ids(s0)[2]! });
    expect(ids(s1)).not.toContain(ids(s0)[2]);
    expect(s1.selectedId).toBe(ids(s0)[3]);
  });

  it('adds/removes blocks within maxBlocks', () => {
    const s0 = initEditor(clone());
    const hero = s0.config.sections[0]!;
    expect(hero.blocks).toHaveLength(3);
    const s1 = run(s0, { type: 'addBlock', id: hero.id });
    expect(s1.config.sections[0]!.blocks).toHaveLength(3);
    expect(s1.notice).toMatch(/up to 3 stats/);
    const s2 = run(s1, { type: 'removeBlock', id: hero.id, blockId: hero.blocks![0]!.id }, { type: 'addBlock', id: hero.id });
    expect(s2.config.sections[0]!.blocks).toHaveLength(3);
    expect(s2.config.sections[0]!.blocks![2]!.type).toBe('stat');
  });

  it('edits settings, colours detach the preset, typing coalesces into one undo step', () => {
    const s0 = initEditor({ ...clone(), settings: { ...clone().settings, stylePreset: 'ocean' } });
    const id = ids(s0)[0]!;
    const s1 = run(s0, { type: 'setSection', id, key: 'heading', value: 'H' }, { type: 'setSection', id, key: 'heading', value: 'He' }, { type: 'setSection', id, key: 'heading', value: 'Hey' });
    expect(s1.config.sections[0]!.settings!.heading).toBe('Hey');
    expect(s1.past).toHaveLength(1);
    const s2 = run(s1, { type: 'setGlobal', key: 'primaryColor', value: '#123456' });
    expect(s2.config.settings.stylePreset).toBeNull();
    const s3 = run(s2, { type: 'undo' }, { type: 'undo' });
    expect(s3.config).toEqual(s0.config);
  });

  it('caps undo history at 50', () => {
    let s = initEditor(clone());
    for (let i = 0; i < 60; i++) s = run(s, { type: 'toggle', id: ids(s)[1]! });
    expect(s.past).toHaveLength(HISTORY_LIMIT);
  });
});

describe('change counter vs published', () => {
  it('counts added, removed, changed, moved sections and global groups', () => {
    const published = clone();
    expect(countChanges(published, published)).toBe(0);
    let s = initEditor(structuredClone(published));
    s = run(
      s,
      { type: 'move', from: 0, to: 1 }, // 1 moved
      { type: 'toggle', id: ids(s)[3]! }, // 1 changed
      { type: 'remove', id: ids(s)[4]! }, // 1 removed
      { type: 'add', sectionType: 'rich-text' }, // 1 added
      { type: 'setGlobal', key: 'primaryColor', value: '#000000' }, // colours
      { type: 'setGlobal', key: 'cornerStyle', value: 'square' }, // corners
    );
    expect(summarizeChanges(s.config, published)).toMatchObject({ added: 1, removed: 1, changed: 1, moved: 1, groups: ['colours', 'corners'], total: 6 });
  });
});

describe('AutosaveController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(save: (value: number, rev: number) => Promise<{ revision: number; result: number }>) {
    const statuses: AutosaveStatus[] = [];
    const onConflict = vi.fn();
    const onInvalid = vi.fn();
    const saveMock = vi.fn(save);
    const c = new AutosaveController<number, number>({ delay: 600, baseRevision: 1, save: saveMock, onStatus: (s) => statuses.push(s), onConflict, onInvalid });
    return { c, saveMock, statuses, onConflict, onInvalid };
  }

  it('debounces 600 ms after the last change and sends base_revision', async () => {
    const { c, saveMock } = setup(async (_v, rev) => ({ revision: rev + 1, result: 0 }));
    c.schedule(1);
    await vi.advanceTimersByTimeAsync(500);
    c.schedule(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(saveMock).not.toHaveBeenCalled();
    expect(c.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(saveMock).toHaveBeenCalledExactlyOnceWith(2, 1);
    await vi.runAllTimersAsync();
    expect(c.baseRevision).toBe(2);
    expect(c.busy).toBe(false);
    expect(c.status).toBe('saved');
  });

  it('keeps one request in flight and then saves the latest queued state', async () => {
    let resolve!: (v: { revision: number; result: number }) => void;
    const { c, saveMock } = setup((_v, rev) => (rev === 1 ? new Promise((r) => (resolve = r)) : Promise.resolve({ revision: rev + 1, result: 0 })));
    c.schedule(1);
    await vi.advanceTimersByTimeAsync(600);
    c.schedule(2);
    c.schedule(3);
    await vi.advanceTimersByTimeAsync(600);
    expect(saveMock).toHaveBeenCalledTimes(1);
    resolve({ revision: 2, result: 0 });
    await vi.runAllTimersAsync();
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock).toHaveBeenLastCalledWith(3, 2);
  });

  it('409 stops autosave and reports a conflict', async () => {
    const { c, saveMock, onConflict } = setup(async () => {
      throw new ApiError(409, 'revision_conflict', 'Changed elsewhere');
    });
    c.schedule(1);
    await vi.runAllTimersAsync();
    expect(onConflict).toHaveBeenCalled();
    expect(c.status).toBe('conflict');
    c.schedule(2);
    await vi.runAllTimersAsync();
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('422 reports field details and keeps going', async () => {
    const { c, onInvalid } = setup(async () => {
      throw new ApiError(422, 'validation_failed', 'Invalid', { 'config.sections.0.settings.heading': ['Too long'] });
    });
    c.schedule(1);
    await vi.runAllTimersAsync();
    expect(onInvalid).toHaveBeenCalledWith({ 'config.sections.0.settings.heading': ['Too long'] });
    expect(c.status).toBe('invalid');
  });

  it('flush saves immediately (publish path)', async () => {
    const { c, saveMock } = setup(async (_v, rev) => ({ revision: rev + 1, result: 0 }));
    c.schedule(7);
    await c.flush();
    expect(saveMock).toHaveBeenCalledWith(7, 1);
    expect(c.busy).toBe(false);
  });
});

describe('postMessage bridge', () => {
  const frame = {} as Window;
  const origin = 'http://demo.localhost:3000';
  const ready = { source: 'storeplix-preview', v: 1, type: 'ready', path: '/' };

  it('accepts only the iframe window, the exact origin and valid shapes', () => {
    expect(readPreviewMessage({ source: frame, origin, data: ready }, frame, origin)).toEqual(ready);
    expect(readPreviewMessage({ source: {} as Window, origin, data: ready }, frame, origin)).toBeNull();
    expect(readPreviewMessage({ source: frame, origin: 'http://evil.localhost:3000', data: ready }, frame, origin)).toBeNull();
    expect(readPreviewMessage({ source: frame, origin: 'http://demo.localhost:3001', data: ready }, frame, origin)).toBeNull();
    expect(readPreviewMessage({ source: frame, origin, data: { ...ready, v: 2 } }, frame, origin)).toBeNull();
    expect(readPreviewMessage({ source: frame, origin, data: { ...ready, source: 'storeplix-editor' } }, frame, origin)).toBeNull();
    expect(readPreviewMessage({ source: frame, origin, data: { ...ready, token: 'x' } }, frame, origin)).toBeNull();
    expect(readPreviewMessage({ source: frame, origin, data: 'ready' }, frame, origin)).toBeNull();
    expect(readPreviewMessage({ source: frame, origin, data: { source: 'storeplix-preview', v: 1, type: 'section-click', section_id: '<img>' } }, frame, origin)).toBeNull();
    expect(readPreviewMessage({ source: frame, origin, data: ready }, null, origin)).toBeNull();
  });

  it('posts with an explicit targetOrigin and the protocol envelope', () => {
    const post = vi.fn();
    expect(postToPreview({ postMessage: post } as unknown as Window, origin, { type: 'refresh' })).toBe(true);
    expect(post).toHaveBeenCalledWith({ source: 'storeplix-editor', v: 1, type: 'refresh' }, origin);
    expect(postToPreview({ postMessage: post } as unknown as Window, null, { type: 'refresh' })).toBe(false);
  });

  it('derives the origin from the preview URL', () => {
    expect(previewOriginOf('http://demo.localhost:3000/?preview=abc')).toBe(origin);
    expect(previewOriginOf('javascript:alert(1)')).toBeNull();
    expect(previewOriginOf('nope')).toBeNull();
  });
});

describe('client JSON Schema validation (ajv)', () => {
  it('defaults are valid', () => {
    expect(validateThemeConfig(clone())).toEqual({});
  });

  it('maps errors to API dot paths', () => {
    const c = clone();
    c.sections[0]!.settings!.heading = 'x'.repeat(61);
    c.settings.primaryColor = 'red';
    (c.sections[1]!.blocks![0]!.settings as Record<string, unknown>).href = 'javascript:alert(1)';
    const errors = validateThemeConfig(c);
    expect(errors['config.sections.0.settings.heading']).toEqual(['Use at most 60 characters.']);
    expect(errors['config.settings.primaryColor']).toBeDefined();
    expect(errors['config.sections.1.blocks.0.settings.href']).toBeDefined();
    expect(toDotPath('/sections/2/settings')).toBe('config.sections.2.settings');
  });

  it('rejects unknown keys and fonts', () => {
    const c = clone() as ThemeConfig & { settings: Record<string, unknown> };
    c.settings.fontFamily = 'Comic Sans';
    (c.sections[0]!.settings as Record<string, unknown>).evil = 1;
    const errors = validateThemeConfig(c);
    expect(errors['config.settings.fontFamily']).toBeDefined();
    expect(errors['config.sections.0.settings.evil']).toBeDefined();
  });
});

describe('client validator parity with @storeplix/themes fixtures', () => {
  const files = import.meta.glob<{ default: unknown }>('../../../../../packages/themes/fixtures/modern-commerce/*/*.json', { eager: true });
  const entries = Object.entries(files);

  it('finds the shared fixtures', () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  it.each(entries.filter(([p]) => p.includes('/valid/')))('accepts %s', (_p, mod) => {
    expect(validateThemeConfig(mod.default as ThemeConfig)).toEqual({});
  });

  it.each(entries.filter(([p]) => p.includes('/invalid/')))('rejects %s', (_p, mod) => {
    const { config } = mod.default as { config: ThemeConfig };
    expect(Object.keys(validateThemeConfig(config)).length).toBeGreaterThan(0);
  });
});
