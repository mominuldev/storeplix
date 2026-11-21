import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { jsonResponse, renderApp, settingsFixture, signedIn, store } from '../test/utils';
import { catalog, menus, page, pagesList, previewToken, storeTheme } from './online-store.fixtures';

type Role = 'owner' | 'admin' | 'staff';

function onlineStoreApi(role: Role, extra: Parameters<typeof signedIn>[1] = {}) {
  const theme = storeTheme();
  return signedIn(role, {
    'GET /themes': jsonResponse(200, { data: catalog }),
    'GET /stores/S1/themes': jsonResponse(200, { data: [theme] }),
    'GET /stores/S1/themes/modern-commerce': jsonResponse(200, { data: theme }),
    'GET /stores/S1/pages': jsonResponse(200, pagesList),
    'GET /stores/S1/navigation': jsonResponse(200, { data: menus }),
    'GET /page-templates': jsonResponse(200, { data: [] }),
    'POST /stores/S1/preview-token': jsonResponse(201, { data: previewToken }),
    'GET /stores/S1/settings': jsonResponse(200, { data: settingsFixture({ seo: { title: null, description: null, share_image: null, hide_from_search: false } }) }),
    ...extra,
  });
}

const writes = (api: ReturnType<typeof signedIn>) => api.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');

describe('Online store — staff read-only (contract §6)', () => {
  it('Themes: banner, no Apply for coming-soon or staff', async () => {
    onlineStoreApi('staff');
    renderApp(<AppRoutes />, { route: '/online-store/themes' });
    expect(await screen.findByText('View only.')).toBeInTheDocument();
    const boutique = await screen.findByRole('article', { name: 'Boutique theme' });
    expect(within(boutique).getByText('Coming soon', { selector: 'span' })).toBeInTheDocument();
    expect(within(boutique).getByRole('button', { name: 'Coming soon' })).toBeDisabled();
    const gallery = screen.getByRole('article', { name: 'Gallery theme' });
    expect(within(gallery).getByRole('button', { name: 'View' })).toBeEnabled();
  });

  it('Pages: no New page, no row actions, View instead of Edit', async () => {
    onlineStoreApi('staff');
    renderApp(<AppRoutes />, { route: '/online-store/pages' });
    expect(await screen.findByText('About us')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'About us actions' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View About us' })).toBeInTheDocument();
  });

  it('Navigation: no drag handles, edit or add controls', async () => {
    onlineStoreApi('staff');
    renderApp(<AppRoutes />, { route: '/online-store/navigation' });
    expect((await screen.findAllByText('Home'))[0]).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reorder/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('SEO and Brand style: inputs disabled, nothing saved', async () => {
    const api = onlineStoreApi('staff');
    renderApp(<AppRoutes />, { route: '/online-store/seo' });
    expect(await screen.findByLabelText(/^Title/)).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Hide the whole shop from Google' })).toBeDisabled();
    expect(writes(api)).toHaveLength(0);
  });

  it('Theme editor opens in view mode without Publish, Undo or grips', async () => {
    const api = onlineStoreApi('staff');
    renderApp(<AppRoutes />, { route: '/online-store/editor?page=home' });
    expect(await screen.findByText('View only')).toBeInTheDocument();
    expect(screen.getByText(/Ask a manager to make changes/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /^Reorder/ })).toHaveLength(0);
    expect(screen.getAllByLabelText(/^Heading/)[0]).toBeDisabled();
    // Only the preview token (a read) is POSTed.
    expect(writes(api).map(([u]) => new URL(String(u)).pathname)).toEqual(['/api/v1/stores/S1/preview-token']);
  });
});

describe('Theme editor — autosave and conflicts', () => {
  it('debounces a draft save with base_revision, then shows the reload prompt on 409', async () => {
    let saves = 0;
    const bodies: unknown[] = [];
    onlineStoreApi('owner', {
      'PUT /stores/S1/themes/modern-commerce/draft': (init) => {
        saves++;
        bodies.push(JSON.parse(String(init.body)));
        return saves === 1
          ? jsonResponse(200, { data: storeTheme({ draft_revision: 4, draft_config: (bodies[0] as { config: never }).config }) })
          : jsonResponse(409, { error: { code: 'revision_conflict', message: 'Changed elsewhere' } });
      },
    });
    renderApp(<AppRoutes />, { route: '/online-store/editor?page=home' });
    const heading = (await screen.findAllByLabelText(/^Heading/))[0]!;
    fireEvent.change(heading, { target: { value: 'Eid is here' } });
    expect(saves).toBe(0);
    await waitFor(() => expect(saves).toBe(1), { timeout: 3000 });
    const first = bodies[0] as { base_revision: number; config: { sections: { settings: { heading: string } }[] } };
    expect(first.base_revision).toBe(3);
    expect(first.config.sections[0]!.settings.heading).toBe('Eid is here');
    expect(await screen.findByText('1 change')).toBeInTheDocument();

    fireEvent.change(heading, { target: { value: 'Eid is here!' } });
    await waitFor(() => expect(saves).toBe(2), { timeout: 3000 });
    expect((bodies[1] as { base_revision: number }).base_revision).toBe(4);
    expect(await screen.findByRole('dialog', { name: 'Changed somewhere else' })).toBeInTheDocument();
    expect(screen.getByText('Changed in another tab or by a teammate. Reload to continue.')).toBeInTheDocument();
  });

  it('does not save while a field is invalid (client JSON Schema)', async () => {
    let saves = 0;
    onlineStoreApi('owner', {
      'PUT /stores/S1/themes/modern-commerce/draft': () => {
        saves++;
        return jsonResponse(200, { data: storeTheme() });
      },
    });
    renderApp(<AppRoutes />, { route: '/online-store/editor?page=home' });
    const heading = (await screen.findAllByLabelText(/^Heading/))[0]!;
    fireEvent.change(heading, { target: { value: 'x'.repeat(61) } });
    expect(await screen.findByText('Use at most 60 characters.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 900));
    expect(saves).toBe(0);
  });

  it('enforces maxInstances in the Add section picker', async () => {
    onlineStoreApi('owner');
    renderApp(<AppRoutes />, { route: '/online-store/editor?page=home' });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add section' }))[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Add a section' });
    expect(within(dialog).getByRole('button', { name: /^Hero/ })).toBeDisabled();
    expect(within(dialog).getByText('Hero can only be added once.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Text/ })).toBeEnabled();
  });
});

describe('Navigation editor', () => {
  it('flags links whose page is not published', async () => {
    onlineStoreApi('owner');
    renderApp(<AppRoutes />, { route: '/online-store/navigation' });
    expect(await screen.findByText('Page not published')).toBeInTheDocument();
  });

  it('rejects javascript: web addresses (safe href)', async () => {
    const api = onlineStoreApi('owner');
    renderApp(<AppRoutes />, { route: '/online-store/navigation' });
    await userEvent.click(await screen.findByRole('button', { name: 'Add a link' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a link' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Links to'), 'url');
    const address = within(dialog).getByLabelText('Web address');
    await userEvent.clear(address);
    await userEvent.type(address, 'javascript:alert(1)');
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Evil');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add link' }));
    expect(within(dialog).getByText(/full web address/)).toBeInTheDocument();
    expect(screen.queryByText('Evil')).not.toBeInTheDocument();
    expect(writes(api).filter(([u]) => String(u).includes('/navigation'))).toHaveLength(0);
  });

  it('adds a safe link and saves the whole menu with its revision', async () => {
    let body: { items: { label: string }[]; revision: number } | null = null;
    onlineStoreApi('owner', {
      'PUT /stores/S1/navigation/main': (init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse(200, { data: { ...menus[0], revision: 5 } });
      },
    });
    renderApp(<AppRoutes />, { route: '/online-store/navigation' });
    await userEvent.click(await screen.findByRole('button', { name: 'Add a link' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a link' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Links to'), 'url');
    const address = within(dialog).getByLabelText('Web address');
    await userEvent.clear(address);
    await userEvent.type(address, 'https://facebook.com/mugdho');
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Facebook');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add link' }));
    expect(await screen.findByText('1 unsaved change')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save menu' }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.revision).toBe(4);
    expect(body!.items.map((i) => i.label)).toEqual(['Home', 'About us', 'Size guide', 'Facebook']);
    expect(body!.items[0]).not.toHaveProperty('href');
  });
});

describe('Page editor', () => {
  it('keeps an unsafe button link local and does not autosave it', async () => {
    let patches = 0;
    onlineStoreApi('owner', {
      'GET /stores/S1/pages/P1': jsonResponse(200, { data: page({ body: [{ id: 'btn00001', type: 'button', label: 'Chat', href: '/pages/contact', style: 'primary' }] }) }),
      'PATCH /stores/S1/pages/P1': () => {
        patches++;
        return jsonResponse(200, { data: page() });
      },
    });
    renderApp(<AppRoutes />, { route: '/online-store/pages/P1' });
    const href = (await screen.findAllByLabelText(/^Goes to/))[0]!;
    fireEvent.change(href, { target: { value: 'javascript:alert(1)' } });
    expect((await screen.findAllByText(/Use a link starting with \//))[0]).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1100));
    expect(patches).toBe(0);
    fireEvent.change(href, { target: { value: 'https://wa.me/8801712345678' } });
    await waitFor(() => expect(patches).toBe(1), { timeout: 3000 });
  });
});

describe('Onboarding 04 · Pick a theme', () => {
  it('applies the theme, saves colour, then lands on the dashboard', async () => {
    const calls: string[] = [];
    let patch: unknown = null;
    onlineStoreApi('owner', {
      'POST /stores/S1/themes/modern-commerce/apply': () => {
        calls.push('apply');
        return jsonResponse(200, { data: storeTheme({ applied_at: '2026-11-21T00:00:00Z' }) });
      },
      'PATCH /stores/S1/settings': (init) => {
        calls.push('settings');
        patch = JSON.parse(String(init.body));
        return jsonResponse(200, { data: settingsFixture() });
      },
      'GET /stores': jsonResponse(200, { data: [store()] }),
    });
    renderApp(<AppRoutes />, { route: '/onboarding/theme' });
    expect(await screen.findByRole('radio', { name: /Gallery/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Boutique/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Coral' }));
    await userEvent.click(screen.getByRole('button', { name: 'Use Gallery theme' }));
    await waitFor(() => expect(calls).toEqual(['apply', 'settings']));
    expect(patch).toEqual({ branding: { primary_color: '#fc856d' } });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pick a look for your shop' })).not.toBeInTheDocument());
  });

  it('the dashboard checklist marks "Pick a theme" done once a theme was applied', async () => {
    onlineStoreApi('owner', { 'GET /stores/S1/themes': jsonResponse(200, { data: [storeTheme({ applied_at: '2026-11-21T00:00:00Z' })] }) });
    renderApp(<AppRoutes />, { route: '/' });
    const item = await screen.findByText('Pick a theme');
    await waitFor(() => expect(item.closest('button,li,div')?.textContent).toBeTruthy());
    const checklist = screen.getByRole('region', { name: 'Setup checklist' });
    await waitFor(() => expect(within(checklist).getByText('2 of 8 done')).toBeInTheDocument());
  });
});
