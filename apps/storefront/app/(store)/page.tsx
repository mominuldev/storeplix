import { cookies } from 'next/headers';
import { requireCurrentStore } from '@/lib/store';
import { FLASH_COOKIE } from '@/lib/commerce-request';
import { SectionFrame } from '@/themes/section-frame';
import { FlashToast } from '@/themes/modern-commerce/commerce/flash-toast';

/** `sp_flash` = `{tone, message}` written by our own Server Action; anything else is ignored. */
async function readFlash(): Promise<{ tone: 'ok' | 'error'; message: string } | null> {
  const raw = (await cookies()).get(FLASH_COOKIE)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { tone?: unknown; message?: unknown };
    if ((v.tone === 'ok' || v.tone === 'error') && typeof v.message === 'string' && v.message.length <= 300) return { tone: v.tone, message: v.message };
  } catch {
    // ignore
  }
  return null;
}

/** Home: the resolved theme config's sections in order; disabled and unknown sections are skipped. */
export default async function StoreHomePage() {
  const { host, theme, themeConfig, config, mode } = await requireCurrentStore();
  if (mode === 'coming_soon') return null; // layout renders Coming soon

  const ctx = { store: config.store, host, media: config.media, preview: mode === 'preview' };
  const flash = await readFlash();
  return (
    <>
      <FlashToast flash={flash} />
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
