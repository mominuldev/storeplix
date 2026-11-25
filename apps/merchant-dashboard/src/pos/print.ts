// PHASE-8-8D P88D-11: browser print dialog with an 80 mm page; no hardware code (no ESC/POS, no WebUSB).
const PRINT_STYLE_ID = 'sp-pos-print-page';

/** Opens the print dialog for the `PrintArea` content with an 80 mm page; restores the page afterwards. */
export function printPos(): void {
  if (typeof window === 'undefined' || typeof window.print !== 'function') return;
  const style = document.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = '@page { size: 80mm auto; margin: 0; }';
  document.head.appendChild(style);
  document.body.classList.add('pos-printing');
  const cleanup = () => {
    document.body.classList.remove('pos-printing');
    document.getElementById(PRINT_STYLE_ID)?.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  try {
    window.print();
  } finally {
    // Browsers that don't fire `afterprint` (or block on print) still get cleaned up.
    setTimeout(cleanup, 0);
  }
}

export function removePrintStyle(): void {
  document.getElementById(PRINT_STYLE_ID)?.remove();
}
