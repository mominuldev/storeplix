import { requireCurrentStore } from '@/lib/store';
import { SectionFrame } from '@/themes/section-frame';

/** Home: the resolved theme config's sections in order; disabled and unknown sections are skipped. */
export default async function StoreHomePage() {
  const { host, theme, themeConfig, config, mode } = await requireCurrentStore();
  if (mode === 'coming_soon') return null; // layout renders Coming soon

  const ctx = { store: config.store, host, media: config.media };
  return (
    <>
      {themeConfig.sections
        .filter((section) => section.enabled)
        .map((section) => {
          const def = theme.sections[section.type];
          if (!def) return null;
          const { Component } = def;
          return (
            <SectionFrame key={section.id} id={section.id} type={section.type} design={section.settings.design}>
              <Component id={section.id} settings={section.settings} blocks={section.blocks} ctx={ctx} />
            </SectionFrame>
          );
        })}
    </>
  );
}
