import { requireCurrentStore } from '@/lib/store';

export default async function StoreHomePage() {
  const { host, theme, themeConfig, config, mode } = await requireCurrentStore();
  if (mode === 'coming_soon') return null; // layout renders Coming soon

  return (
    <>
      {themeConfig.sections
        .filter((section) => section.enabled)
        .map((section) => {
          const Section = theme.sections[section.type];
          return Section ? <Section key={section.key} settings={section.settings} store={config.store} host={host} /> : null;
        })}
    </>
  );
}
