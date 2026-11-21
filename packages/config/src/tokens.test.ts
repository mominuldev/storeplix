import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { colors } from './tokens';

describe('tokens', () => {
  it('tokens.css and tokens.ts agree on brand primary', () => {
    const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
    expect(css).toContain(`--color-brand-600: ${colors.brand[600]}`);
  });
});
