import { expect, test } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { api, demoSession, signInDashboard, urls, waitForStorefront, type Session } from '../support/api';

/**
 * Deferred from Phase 2: Settings → Store details → upload a logo → Save → the storefront header
 * shows it (media processed by the queue worker, revalidation). Restores the previous logo and
 * deletes the uploaded media.
 */
let s: Session;
test.beforeAll(async () => {
  s = await demoSession();
});

/** Solid-colour RGB PNG built in memory (no fixture files). */
function png(size: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('settings: upload a logo → storefront header shows it', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, s);
  const before = await api(s, 'GET', `/stores/${s.storeId}/settings`);
  const previousLogoId: string | null = before.json.data.branding.logo?.id ?? null;
  let newLogoId: string | null = null;
  try {
    await page.goto(`${urls.merchant}/settings/store`);
    const upload = page.waitForResponse((r) => r.url().endsWith('/api/v1/media') && r.request().method() === 'POST');
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'e2e-logo.png', mimeType: 'image/png', buffer: png(400, [20, 140, 90]) });
    const res = await upload;
    expect(res.status()).toBe(201);
    newLogoId = (await res.json()).data.id;

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(async () => (await api(s, 'GET', `/stores/${s.storeId}/settings`)).json.data.branding.logo?.id, { timeout: 15_000 }).toBe(newLogoId);

    await waitForStorefront('/', (html) => html.includes(newLogoId!), 10_000);
    await page.goto(`${urls.storefront}/`);
    const logo = page.getByRole('banner').locator(`img[src*="${newLogoId}"]`).filter({ visible: true }).first();
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  } finally {
    const r = await api(s, 'PATCH', `/stores/${s.storeId}/settings`, { branding: { logo_media_id: previousLogoId } });
    expect(r.status).toBe(200);
    if (newLogoId) expect((await api(s, 'DELETE', `/media/${newLogoId}`)).status).toBe(204);
  }
  if (newLogoId) await waitForStorefront('/', (html) => !html.includes(newLogoId!), 10_000);
});
