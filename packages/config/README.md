# @storeplix/config

Shared design tokens and tooling config. Tokens come from Figma `2W1wMKN79hhcr1czQS63oN`
Foundations (01 Color `127:19`, 02 Typography `128:131`, 03 Spacing/radius/elevation `128:221`).

## Tailwind v4 tokens

We use **Tailwind CSS v4** with a CSS-first `@theme` (no JS preset).

```css
/* app entry CSS (Vite apps: src/index.css · Next: app/globals.css) */
@import 'tailwindcss';
@import '@storeplix/config/tokens.css';
/* let Tailwind scan shared UI components */
@source '../node_modules/@storeplix/ui/src';
```

- Vite: add `@tailwindcss/vite` to `vite.config.ts` plugins.
- Next.js: use `@tailwindcss/postcss` in `postcss.config.mjs`.
- Load Inter (Google Fonts `<link>` in Vite `index.html`, or `next/font/google` with `variable` and keep `--font-sans` pointing to Inter).

### Utilities generated

| Group | Classes |
|---|---|
| Brand | `bg-brand-50/100/500/600/700` (600 = primary) |
| Accent | `bg-accent-100`, `text-accent-500` |
| Text | `text-text-primary`, `text-text-secondary`, `text-text-muted`, `text-text-inverse` |
| Surface | `bg-surface-canvas`, `bg-surface-card`, `bg-surface-subtle` |
| Border | `border-border-default`, `border-border-strong` |
| Status | `text-success bg-success-bg`, `warning`, `danger`, `info` (+ `-bg`) |
| Type | `text-display` (40/48 bold), `text-heading` (20/28 semibold), `text-heading-24` (24/32 semibold), `text-body-lg` (16/24), `text-body` (14/20), `text-caption` (12/16); add `font-medium`/`font-semibold` for Medium/Semibold styles |
| Spacing | default 4px scale = Figma `space/1..10` (`p-1`=4 … `p-10`=40); `w-sidebar` 256, `w-sidebar-collapsed` 72, `h-topbar` 64 |
| Radius | `rounded-sm` 6, `rounded-md` 8, `rounded-lg` 12, `rounded-control` 10, `rounded-card` 16, `rounded-full` |
| Elevation | `shadow-elevation-1` (cards/tables), `shadow-focus` (4px brand/600 @14% focus ring) |

JS values (charts etc.): `import { colors } from '@storeplix/config/tokens'`.

## TypeScript

```json
{ "extends": "@storeplix/config/tsconfig/react.json" }   // Vite apps / React packages
{ "extends": "@storeplix/config/tsconfig/next.json" }    // Next.js
{ "extends": "@storeplix/config/tsconfig/base.json" }    // plain TS
```

## ESLint (flat config) / Prettier

```js
// eslint.config.js
import config from '@storeplix/config/eslint/react'; // or '@storeplix/config/eslint'
export default config;
```

`package.json`: `"prettier": "@storeplix/config/prettier"`.
