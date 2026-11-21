/** Same values as tokens.css, for JS consumers (charts, canvas, inline theming). */
export const colors = {
  brand: { 50: '#f3f2ff', 100: '#e4e2ff', 500: '#7a74ff', 600: '#5b53ff', 700: '#463ee0' },
  accent: { 100: '#ffe8e2', 500: '#fc856d' },
  text: { primary: '#0d0d18', secondary: '#5c6078', muted: '#81859f', inverse: '#ffffff' },
  surface: { canvas: '#fcfcfc', card: '#ffffff', subtle: '#f3f4f8' },
  border: { default: '#ecedf2', strong: '#d9dbe5' },
  status: {
    success: '#14833b', successBg: '#e3f4e8',
    warning: '#b76e00', warningBg: '#fff2d9',
    danger: '#c8312b', dangerBg: '#fce6e5',
    info: '#2563eb', infoBg: '#e3ecfd',
  },
} as const;

export const radius = { sm: 6, md: 8, lg: 12, card: 16, full: 999 } as const;
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;
export const layout = { sidebar: 256, sidebarCollapsed: 72, topbar: 64, contentPadding: 32, contentGap: 20, mobilePadding: 16 } as const;
export const elevation1 = '0 1px 3px 0 #1a1f1a14, 0 4px 12px 0 #1a1f1a0f';
