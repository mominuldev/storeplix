import { expect, test } from '@playwright/test';
import { urls } from '../playwright.config';

test('GET /api/v1/health returns the contract envelope', async ({ request }) => {
  const res = await request.get(`${urls.api}/api/v1/health`, { headers: { Accept: 'application/json' } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('ok');
  expect(typeof body.data.version).toBe('string');
  expect(typeof body.data.time).toBe('string');
});

test('storefront config rejects calls without the storefront key', async ({ request }) => {
  const res = await request.get(`${urls.api}/api/v1/storefront/config`, {
    headers: { Accept: 'application/json', 'X-Storefront-Host': 'demo.localhost' },
  });
  expect([401, 403]).toContain(res.status());
  const body = await res.json();
  expect(body.error?.code).toBeTruthy();
});
