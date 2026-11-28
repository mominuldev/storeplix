import type { AdminHelpArticle, PlatformRole } from '@storeplix/types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { adminSession, emptyList, jsonResponse, mockApi, on, renderApp } from '../test/utils';
import { article, articlePage, categories, summary, translation } from './fixtures';

const catsOk = on('GET', '/admin/help-categories', () => jsonResponse(200, { data: categories }));

function editorApi(a: AdminHelpArticle = article(), extra: Parameters<typeof mockApi>[0] = []) {
  let current = a;
  return mockApi([
    ...extra,
    on('PATCH', '/admin/help-articles/A1', (c) => {
      current = { ...current, revision: current.revision + 1, translations: { ...current.translations, en: { ...current.translations.en, ...((c.body as { translations: { en: object } }).translations.en), has_unpublished_changes: true } } };
      return jsonResponse(200, { data: current });
    }),
    on('GET', '/admin/help-articles/A1', () => jsonResponse(200, { data: current })),
    on('GET', '/admin/help-articles', () => articlePage([summary({ id: 'A9', title: 'Steadfast delivery charges' })])),
    catsOk,
  ]);
}

const openMarkdown = async () => {
  await userEvent.click(await screen.findByRole('tab', { name: 'Markdown' }));
  return screen.findByLabelText('Article Markdown (English)');
};

describe('help articles list (2134:10410)', () => {
  it('shows stats, tab counts and rows; maps tabs, search, chips and paging to the query; row opens the editor', async () => {
    const api = mockApi([
      on('GET', '/admin/help-articles', () =>
        articlePage([summary(), summary({ id: 'A3', slug: 'pos-open-register', title: 'Set up a cash register (POS)', status: 'scheduled', scheduled_at: '2026-12-01T04:00:00Z', languages: { en: 'draft', bn: 'missing' }, helpful: { percent: 64, votes: 98 } })], { total: 30, last_page: 2 }),
      ),
      on('GET', '/admin/help-articles/A1', () => jsonResponse(200, { data: article() })),
      catsOk,
    ]);
    renderApp(<AppRoutes />, { route: '/help-articles' });
    expect(await screen.findByRole('heading', { name: 'Help articles' })).toBeInTheDocument();
    expect(await screen.findByText('How to book a parcel with Steadfast')).toBeInTheDocument();
    const stats = screen.getByRole('region', { name: 'Help article stats' });
    expect(within(stats).getByText('146')).toBeInTheDocument();
    expect(within(stats).getByText('87%')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /All\s*158/ })).toBeInTheDocument();
    expect(screen.getByText('/help/articles/book-steadfast-parcel')).toBeInTheDocument();
    expect(screen.getByText('Scheduled 1 Dec')).toBeInTheDocument();
    expect(screen.getByText('বাংলা missing')).toBeInTheDocument();
    expect(screen.getByText('64% · 98')).toHaveClass('text-warning');
    expect(screen.getByText('92% · 232')).not.toHaveClass('text-warning');

    const last = () => api.find('GET', '/admin/help-articles').at(-1)!.url.searchParams;
    await userEvent.click(screen.getByRole('tab', { name: /Missing বাংলা/ }));
    await waitFor(() => expect(last().get('filter[tab]')).toBe('missing_bn'));

    await userEvent.type(screen.getByLabelText('Search title, slug or keyword'), 'st');
    await waitFor(() => expect(last().get('filter[q]')).toBe('st'));

    await userEvent.click(screen.getByRole('button', { name: 'Category' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Payments' }));
    await waitFor(() => expect(last().get('filter[category]')).toBe('C2'));

    await userEvent.click(screen.getByRole('button', { name: 'Sort' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Helpful rate' }));
    await waitFor(() => expect(last().get('sort')).toBe('helpful'));

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(last().get('page')).toBe('2'));

    await userEvent.click(screen.getByText('How to book a parcel with Steadfast'));
    expect(await screen.findByRole('heading', { name: 'Edit article' })).toBeInTheDocument();
  });

  it('empty, error and loading states', async () => {
    mockApi([on('GET', '/admin/help-articles', () => emptyList({ counts: { all: 0 }, stats: { published: 0, drafts: 0, missing_bn: 0, helpful_percent_30d: null } })), catsOk]);
    const first = renderApp(<AppRoutes />, { route: '/help-articles' });
    expect(await screen.findByText('No help articles yet')).toBeInTheDocument();
    first.unmount();

    mockApi([on('GET', '/admin/help-articles', () => jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } })), catsOk]);
    const second = renderApp(<AppRoutes />, { route: '/help-articles' });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    second.unmount();

    mockApi([on('GET', '/admin/help-articles', () => new Promise<Response>(() => undefined) as unknown as Response), catsOk]);
    renderApp(<AppRoutes />, { route: '/help-articles' });
    expect(await screen.findByRole('status', { name: 'Loading help articles' })).toBeInTheDocument();
  });

  it('New article: slug follows the title until edited, creates the draft and opens the editor', async () => {
    const api = mockApi([
      on('POST', '/admin/help-articles', () => jsonResponse(201, { data: article({ id: 'A7', status: 'draft', first_published_at: null }) })),
      on('GET', '/admin/help-articles/A7', () => jsonResponse(200, { data: article({ id: 'A7', status: 'draft', first_published_at: null }) })),
      on('GET', '/admin/help-articles', () => articlePage([])),
      catsOk,
    ]);
    renderApp(<AppRoutes />, { route: '/help-articles/new' });
    const dialog = await screen.findByRole('dialog', { name: 'New article' });
    await userEvent.type(within(dialog).getByLabelText('Title (English)'), 'Connect bKash PGW!');
    expect(within(dialog).getByLabelText('Slug')).toHaveValue('connect-bkash-pgw');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    expect(await within(dialog).findByText('Pick a category')).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText('Category'), 'C2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(api.find('POST', '/admin/help-articles')[0]!.body).toEqual({ slug: 'connect-bkash-pgw', category_id: 'C2', title_en: 'Connect bKash PGW!' }));
    expect(await screen.findByRole('heading', { name: 'Edit article' })).toBeInTheDocument();
  });

  it.each<[PlatformRole, boolean]>([
    ['super_admin', true],
    ['support', true],
    ['billing', false],
    ['read_only', false],
  ])('%s: Help articles nav and route gated by manage_help_content (%s)', async (role, allowed) => {
    const api = mockApi([on('GET', '/admin/help-articles', () => articlePage([summary()])), catsOk, on('GET', '/admin/overview', () => jsonResponse(500, {}))], { session: adminSession(role) });
    renderApp(<AppRoutes />, { route: '/help-articles' });
    const nav = await screen.findByRole('navigation');
    if (allowed) {
      expect(within(nav).getByRole('link', { name: 'Help articles' })).toHaveAttribute('href', '/help-articles');
      expect(await screen.findByText('How to book a parcel with Steadfast')).toBeInTheDocument();
    } else {
      expect(within(nav).queryByRole('link', { name: 'Help articles' })).toBeNull();
      expect(await screen.findByText('You don’t have access to help articles')).toBeInTheDocument();
      expect(api.find('GET', '/admin/help-articles')).toHaveLength(0);
    }
  });
});

describe('categories drawer', () => {
  it('lists categories, reorders with the arrows and blocks deleting a non-empty category', async () => {
    const api = mockApi([
      on('POST', '/admin/help-categories/reorder', (c) => jsonResponse(200, { data: (c.body as { ids: string[] }).ids.map((id) => categories.find((x) => x.id === id)) })),
      on('DELETE', '/admin/help-categories/C2', () => new Response(null, { status: 204 })),
      on('POST', '/admin/help-categories', () => jsonResponse(201, { data: categories[0] })),
      on('GET', '/admin/help-articles', () => articlePage([])),
      catsOk,
    ]);
    renderApp(<AppRoutes />, { route: '/help-articles' });
    await userEvent.click(await screen.findByRole('button', { name: 'Categories' }));
    const drawer = await screen.findByRole('dialog', { name: 'Categories' });
    expect(await within(drawer).findByText('Couriers')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Delete Couriers' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: 'Delete Payments' })).toBeEnabled();

    await userEvent.click(within(drawer).getByRole('button', { name: 'Move Couriers down' }));
    await waitFor(() => expect(api.find('POST', '/admin/help-categories/reorder')[0]!.body).toEqual({ ids: ['C2', 'C1', 'C3'] }));

    await userEvent.click(within(drawer).getByRole('button', { name: 'Delete Payments' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete category' }));
    await waitFor(() => expect(api.find('DELETE', '/admin/help-categories/C2')).toHaveLength(1));

    await userEvent.click(await screen.findByRole('button', { name: 'Add category' }));
    const form = await screen.findByRole('dialog', { name: 'Add category' });
    await userEvent.type(within(form).getByLabelText('Name (English)'), 'Getting started');
    expect(within(form).getByLabelText('Slug')).toHaveValue('getting-started');
    await userEvent.click(within(form).getByRole('radio', { name: 'rocket' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Add category' }));
    await waitFor(() =>
      expect(api.find('POST', '/admin/help-categories')[0]!.body).toEqual({ slug: 'getting-started', name_en: 'Getting started', name_bn: null, description_en: null, description_bn: null, icon: 'rocket' }),
    );
  });
});

describe('article editor (2134:66712)', () => {
  it('shows status, saved line, language tabs, feedback and related; autosaves Markdown edits after 2 s with the revision', async () => {
    const api = editorApi();
    renderApp(<AppRoutes />, { route: '/help-articles/A1' });
    expect(await screen.findByRole('heading', { name: 'Edit article' })).toBeInTheDocument();
    expect(screen.getAllByText('Published').length).toBeGreaterThan(0);
    expect(screen.getByText(/last published 12 Nov 2026 by Nusrat Jahan/)).toBeInTheDocument();
    expect(screen.getByText('92% yes · 232 votes')).toBeInTheDocument();
    expect(screen.getByText(/Steps didn’t match my screen \(9\)/)).toBeInTheDocument();
    expect(screen.getByText('Track Steadfast parcels')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();

    const md = await openMarkdown();
    expect(md).toHaveValue('## Connect Steadfast\n\nGo to Integrations and paste your API key.');
    fireEvent.change(md, { target: { value: '## Connect Steadfast\n\nGo to **Integrations**.\n\n:::tip\nKeys expire.\n:::' } });
    expect(screen.getByText(/^Unsaved changes/)).toBeInTheDocument();
    await waitFor(() => expect(api.find('PATCH', '/admin/help-articles/A1')).toHaveLength(1), { timeout: 4000 });
    const body = api.find('PATCH', '/admin/help-articles/A1')[0]!.body as { revision: number; translations: { en: { body: { content: unknown[] } }; bn?: unknown } };
    expect(body.revision).toBe(3);
    expect(body.translations.en.body.content[2]).toEqual({ type: 'callout', attrs: { tone: 'tip' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keys expire.' }] }] });
    expect('bn' in body.translations).toBe(false);
    expect(await screen.findByText(/Draft saved just now/)).toBeInTheDocument();
    expect(screen.getByText('Unpublished changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeEnabled();
  }, 10_000);

  it('Markdown with unsupported syntax is reported, never saved, and blocks leaving Markdown', async () => {
    const api = editorApi();
    renderApp(<AppRoutes />, { route: '/help-articles/A1' });
    const md = await openMarkdown();
    fireEvent.change(md, { target: { value: '# Big title\n\n<iframe src="x"></iframe>' } });
    expect(await screen.findByText(/Line 1: Use ## for headings/)).toBeInTheDocument();
    expect(screen.getByText(/Line 3: HTML isn’t allowed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByText(/Fix these lines before leaving Markdown/)).toBeInTheDocument();
    expect(screen.getByLabelText('Article Markdown (English)')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 2300));
    expect(api.find('PATCH', '/admin/help-articles/A1')).toHaveLength(0);
  }, 10_000);

  it('image blocks need alt text: the problem is shown and nothing autosaves', async () => {
    const api = editorApi(
      article({
        media: { M1: { id: 'M1', status: 'ready', url: 'https://cdn.test/m1.webp', width: 1200, height: 640, variants: {}, alt: null } },
        translations: { en: translation({ body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] } }), bn: null },
      }),
    );
    renderApp(<AppRoutes />, { route: '/help-articles/A1' });
    const md = await openMarkdown();
    fireEvent.change(md, { target: { value: 'Hi\n\n![](media:M1)' } });
    expect(await screen.findByText(/This image needs alt text/)).toBeInTheDocument();
    fireEvent.change(md, { target: { value: 'Hi\n\n![Steadfast card](media:M1 "Connected")' } });
    await userEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(within(screen.getByLabelText('Article preview')).getByRole('img', { name: 'Steadfast card' })).toHaveAttribute('src', 'https://cdn.test/m1.webp');
    await waitFor(() => expect(api.find('PATCH', '/admin/help-articles/A1')).toHaveLength(1), { timeout: 4000 });
  }, 10_000);

  it('বাংলা tab: add a translation; Both languages complete once filled; Preview as merchant falls back to English with the note', async () => {
    editorApi();
    renderApp(<AppRoutes />, { route: '/help-articles/A1' });
    await screen.findByRole('heading', { name: 'Edit article' });
    expect(screen.getByText('বাংলা missing')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'বাংলা' }));
    await userEvent.click(screen.getByRole('button', { name: 'Preview as merchant' }));
    const preview = await screen.findByRole('dialog', { name: 'Preview as merchant' });
    expect(within(preview).getByText(/Not available in বাংলা yet — showing English/)).toBeInTheDocument();
    expect(within(preview).getByRole('heading', { name: 'How to book a parcel with Steadfast' })).toBeInTheDocument();
    expect(within(preview).getByText('Go to Integrations and paste your API key.')).toBeInTheDocument();
    await userEvent.click(within(preview).getByRole('button', { name: /close/i }));

    await userEvent.click(screen.getByRole('button', { name: 'Add বাংলা translation' }));
    await userEvent.type(screen.getByLabelText('Title'), 'স্টেডফাস্টে পার্সেল বুক করবেন যেভাবে');
    await userEvent.type(screen.getByRole('textbox', { name: /Summary/ }), 'ঠিকানা কপি না করে অর্ডার পাঠান।');
    const md = await screen.findByRole('tab', { name: 'Markdown' });
    await userEvent.click(md);
    fireEvent.change(screen.getByLabelText('Article Markdown (বাংলা)'), { target: { value: 'ইন্টিগ্রেশনে যান।' } });
    expect(await screen.findByText('Both languages complete')).toBeInTheDocument();
  }, 10_000);

  it('409 revision_conflict on autosave asks to reload and reloads the article', async () => {
    const api = mockApi([
      on('PATCH', '/admin/help-articles/A1', () => jsonResponse(409, { error: { code: 'revision_conflict', message: 'Changed.' } })),
      on('GET', '/admin/help-articles/A1', () => jsonResponse(200, { data: article() })),
      catsOk,
    ]);
    renderApp(<AppRoutes />, { route: '/help-articles/A1' });
    const md = await openMarkdown();
    fireEvent.change(md, { target: { value: 'Changed text' } });
    const dialog = await screen.findByRole('dialog', { name: 'This article changed somewhere else' }, { timeout: 4000 });
    const gets = api.find('GET', '/admin/help-articles/A1').length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload article' }));
    await waitFor(() => expect(api.find('GET', '/admin/help-articles/A1').length).toBeGreaterThan(gets));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'This article changed somewhere else' })).toBeNull());
  }, 10_000);

  it('publish: incomplete translation error switches to the language; schedule sends scheduled_at; archive confirms', async () => {
    const draft = article({ status: 'draft', first_published_at: null, last_published_at: null, last_published_by: null });
    const api = editorApi(draft, [
      on('POST', '/admin/help-articles/A1/publish', (c) =>
        (c.body as { scheduled_at: string | null }).scheduled_at
          ? jsonResponse(200, { data: { ...draft, status: 'scheduled', scheduled_at: (c.body as { scheduled_at: string }).scheduled_at } })
          : jsonResponse(422, { error: { code: 'help_article_incomplete', message: 'Incomplete.', details: { language: 'bn', fields: ['summary', 'body'] } } }),
      ),
      on('POST', '/admin/help-articles/A1/archive', () => jsonResponse(200, { data: { ...draft, status: 'archived', archived_at: '2026-11-28T04:00:00Z' } })),
    ]);
    renderApp(<AppRoutes />, { route: '/help-articles/A1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Publish now' }));
    expect(await screen.findByText('বাংলা is missing: summary, body.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'বাংলা' })).toHaveAttribute('aria-selected', 'true');
    expect(api.find('POST', '/admin/help-articles/A1/publish')[0]!.body).toEqual({ revision: 3, scheduled_at: null });

    const later = new Date(Date.now() + 2 * 86_400_000 + 6 * 3600_000).toISOString().slice(0, 10);
    fireEvent.change(screen.getByLabelText('Schedule (Asia/Dhaka)'), { target: { value: `${later}T10:30` } });
    await userEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(api.find('POST', '/admin/help-articles/A1/publish')).toHaveLength(2));
    expect((api.find('POST', '/admin/help-articles/A1/publish')[1]!.body as { scheduled_at: string }).scheduled_at).toBe(new Date(`${later}T10:30:00+06:00`).toISOString());
    expect(await screen.findByRole('button', { name: 'Cancel schedule' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive this guide?' });
    await userEvent.type(within(confirm).getByLabelText('Reason (optional)'), 'Old flow');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.find('POST', '/admin/help-articles/A1/archive')[0]!.body).toEqual({ reason: 'Old flow' }));
    expect(await screen.findByRole('button', { name: 'Restore to drafts' })).toBeInTheDocument();
  }, 10_000);

  it('Write mode renders the Tiptap editor with the allowed toolbar only', async () => {
    editorApi();
    renderApp(<AppRoutes />, { route: '/help-articles/A1' });
    const toolbar = await screen.findByRole('toolbar', { name: 'Article (English) formatting' }, { timeout: 4000 });
    for (const name of ['Heading', 'Subheading', 'Bold', 'Italic', 'Bulleted list', 'Numbered steps', 'Add link', 'Insert image', 'Callout']) {
      expect(within(toolbar).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(toolbar).queryByRole('button', { name: /code|embed|video/i })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Article (English)' })).toHaveTextContent('Connect Steadfast');
  });
});
