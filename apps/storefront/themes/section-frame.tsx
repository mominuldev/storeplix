import type { ReactNode } from 'react';
import { sectionFrame, type SectionDesign } from './design';

/**
 * Every home section is wrapped in `<section data-sp-section-id>` (editor click-to-select) with
 * design CSS variables and visibility classes built from validated values only.
 */
export function SectionFrame({ id, type, design, children }: { id: string; type: string; design: SectionDesign; children: ReactNode }) {
  const { className, style } = sectionFrame(design);
  return (
    <section data-sp-section-id={id} data-sp-section-type={type} className={className} style={style}>
      {children}
    </section>
  );
}
