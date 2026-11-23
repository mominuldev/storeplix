import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { jsonResponse, renderApp, signedIn, store } from '../test/utils';
import { customer, dashboard, dataImport, inventoryItem, inventoryList, product, productList, summary } from './catalog.fixtures';

const SLOW = { timeout: 5000 };

describe('Products list', () => {
  it('owner sees profit, import/export and delete', async () => {
    signedIn('owner', { 'GET /stores/S1/products': productList([summary()]), 'GET /stores/S1/categories': jsonResponse(200, { data: [] }) });
    renderApp(<AppRoutes />, { route: '/products' });
    const table = await screen.findByRole('table', { name: 'Products' }, SLOW);
    expect(await within(table).findByText('৳ 1,350 · 39%')).toBeInTheDocument();
    expect(within(table).getByText('Low · 2 variants')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Jamdani Three-Piece' }));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('staff: no cost/profit, no delete, no import/export', async () => {
    signedIn('staff', { 'GET /stores/S1/products': productList([summary({ cost_amount: null })]), 'GET /stores/S1/categories': jsonResponse(200, { data: [] }) });
    renderApp(<AppRoutes />, { route: '/products' });
    const table = await screen.findByRole('table', { name: 'Products' }, SLOW);
    await within(table).findByText('Jamdani Three-Piece');
    expect(within(table).queryByText(/Profit/i)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Import CSV' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    await userEvent.click(within(table).getByRole('checkbox', { name: 'Select Jamdani Three-Piece' }));
    const bulk = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(bulk).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(bulk).getByRole('button', { name: 'Publish 1' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Jamdani Three-Piece' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });

  it('shows the empty state when the shop has no products', async () => {
    signedIn('owner', {
      'GET /stores/S1/products': productList([], { counts: { all: 0, active: 0, draft: 0, archived: 0 } }),
      'GET /stores/S1/categories': jsonResponse(200, { data: [] }),
    });
    renderApp(<AppRoutes />, { route: '/products' });
    expect(await screen.findByRole('heading', { name: 'Add your first product' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('shows the error state with Try again', async () => {
    signedIn('owner', { 'GET /stores/S1/products': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) });
    renderApp(<AppRoutes />, { route: '/products' });
    expect(await screen.findByRole('button', { name: 'Try again' }, SLOW)).toBeInTheDocument();
  });
});

describe('Product editor', () => {
  it('maps variants.N.sku errors to the grid cell', async () => {
    signedIn('owner', {
      'GET /stores/S1/products/P1': jsonResponse(200, { data: product() }),
      'GET /stores/S1/categories': jsonResponse(200, { data: [] }),
      'PATCH /stores/S1/products/P1': (init) => {
        expect(JSON.parse(String(init.body)).revision).toBe(3);
        return jsonResponse(422, { error: { code: 'validation_failed', message: 'Invalid', details: { 'variants.1.sku': ['This SKU is already used by another product.'] } } });
      },
    });
    renderApp(<AppRoutes />, { route: '/products/P1' });
    const name = await screen.findByLabelText('Product name', {}, SLOW);
    fireEvent.change(name, { target: { value: 'Jamdani Three-Piece Deluxe' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Save product' }));
    expect(await screen.findByText('This SKU is already used by another product.')).toBeInTheDocument();
    expect(screen.getByLabelText('L / Red SKU')).toHaveAttribute('aria-invalid', 'true');
  });

  it('409 revision_conflict opens the conflict dialog', async () => {
    signedIn('owner', {
      'GET /stores/S1/products/P1': jsonResponse(200, { data: product() }),
      'PATCH /stores/S1/products/P1': jsonResponse(409, { error: { code: 'revision_conflict', message: 'Changed' } }),
    });
    renderApp(<AppRoutes />, { route: '/products/P1' });
    fireEvent.change(await screen.findByLabelText('Product name', {}, SLOW), { target: { value: 'New name' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Save product' }));
    expect(await screen.findByText('Changed in another tab or by a teammate. Reload to continue.')).toBeInTheDocument();
  });

  it('402 plan_limit_reached opens the upgrade dialog', async () => {
    signedIn('owner', {
      'POST /stores/S1/products': jsonResponse(402, { error: { code: 'plan_limit_reached', message: 'Your plan allows 100 products.', details: { products: ['Your plan allows 100 products.'] } } }),
    });
    renderApp(<AppRoutes />, { route: '/products/new' });
    fireEvent.change(await screen.findByLabelText('Product name', {}, SLOW), { target: { value: 'Kurti' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '950' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save product' }));
    expect(await screen.findByText('You’ve reached your plan’s limit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade to Starter' })).toBeInTheDocument();
  });

  it('staff never see cost fields', async () => {
    signedIn('staff', { 'GET /stores/S1/products/P1': jsonResponse(200, { data: product({ variants: [] as never }) }) });
    renderApp(<AppRoutes />, { route: '/products/P1' });
    await screen.findByLabelText('Product name', {}, SLOW);
    expect(screen.queryByLabelText('Cost per item')).toBeNull();
    expect(screen.queryByText('Profit per item')).toBeNull();
  });
});

describe('Inventory adjust', () => {
  it('sends expected_on_hand and shows the 409 stock_changed message', async () => {
    let body: unknown = null;
    signedIn('owner', {
      'GET /stores/S1/inventory': inventoryList([inventoryItem()]),
      'GET /stores/S1/inventory/movements': jsonResponse(200, { data: [] }),
      'POST /stores/S1/inventory/adjustments': (init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse(409, { error: { code: 'stock_changed', message: 'Stock changed', details: { 'items.0.expected_on_hand': ['Stock changed to 12 since you opened this. Check and try again.'] } } });
      },
    });
    renderApp(<AppRoutes />, { route: '/inventory' });
    expect(await screen.findByText('৳ 39,200', {}, SLOW)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust Jamdani Three-Piece M / Red' }));
    await userEvent.type(screen.getByLabelText('New on-hand count'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ reason: 'correction', note: null, items: [{ variant_id: 'V1', mode: 'set', quantity: 10, expected_on_hand: 14 }] }));
    expect(await screen.findByText('Stock changed to 12 since you opened this. Check and try again.')).toBeInTheDocument();
  });

  it('staff see selling value instead of cost value', async () => {
    signedIn('staff', { 'GET /stores/S1/inventory': inventoryList([inventoryItem({ cost_amount: null })]), 'GET /stores/S1/inventory/movements': jsonResponse(200, { data: [] }) });
    renderApp(<AppRoutes />, { route: '/inventory' });
    expect(await screen.findByText('Selling value', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText('Stock value (cost)')).toBeNull();
  });
});

describe('Import wizard', () => {
  it('upload → map → validate (poll) → review filters → run → done', async () => {
    let status: 'uploaded' | 'validating' | 'validated' | 'importing' | 'completed' = 'uploaded';
    let validateBody: { column_map: Record<string, string | null> } | null = null;
    const sum = { total: 3, create: 2, update: 0, unchanged: 0, warnings: 1, errors: 1, over_limit: 0 };
    const current = () => dataImport({ status, summary: status === 'uploaded' ? null : sum, column_map: status === 'uploaded' ? null : { Title: 'name', 'Price (BDT)': 'price', 'Image URL': 'image_urls', 'FB Post Link': null } });
    let polls = 0;
    signedIn('owner', {
      'POST /stores/S1/imports': () => jsonResponse(201, { data: current() }),
      'GET /stores/S1/imports/I1': () => {
        polls++;
        if (status === 'validating' && polls > 1) status = 'validated';
        if (status === 'importing' && polls > 1) status = 'completed';
        return jsonResponse(200, { data: current() });
      },
      'POST /stores/S1/imports/I1/validate': (init) => {
        validateBody = JSON.parse(String(init.body));
        status = 'validating';
        polls = 0;
        return jsonResponse(202, { data: current() });
      },
      'GET /stores/S1/imports/I1/rows': () =>
        jsonResponse(200, {
          data: [{ row_number: 9, status: 'error', action: 'skip', label: 'Silk Saree', key: 'SS-022', preview: { price_amount: null, stock: 0, variants: 1 }, messages: [{ level: 'error', field: 'price', message: 'Price is empty — add a price' }], result_id: null }],
          meta: { current_page: 1, per_page: 25, total: 1, last_page: 1 },
        }),
      'POST /stores/S1/imports/I1/run': () => {
        status = 'importing';
        polls = 0;
        return jsonResponse(202, { data: current() });
      },
      'GET /stores/S1/products': productList([]),
    });
    // Multipart uploads go through XHR (progress); answer like the API would.
    class FakeXhr {
      status = 0;
      statusText = '';
      responseText = '';
      upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      open() {}
      setRequestHeader() {}
      abort() {}
      send() {
        setTimeout(() => {
          this.status = 201;
          this.responseText = JSON.stringify({ data: current() });
          this.onload?.();
        });
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    renderApp(<AppRoutes />, { route: '/products/import' });
    const file = new File(['Title,Price (BDT)\nA,1\n'], 'mugdho-products.csv', { type: 'text/csv' });
    fireEvent.change(await screen.findByLabelText('Drop your CSV here or click to choose', {}, SLOW), { target: { files: [file] } });

    // Map step: suggested map applied; image URL toggle shown disabled.
    expect(await screen.findByLabelText('Field for Title')).toHaveValue('name');
    expect(screen.getByRole('switch', { name: 'Download photos from image URLs' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Check rows' }));
    await waitFor(() => expect(validateBody?.column_map.Title).toBe('name'));

    // Polls until validated, then review rows with the Errors filter preselected.
    expect(await screen.findByText('Price is empty — add a price', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Errors 1' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 products' }));
    expect(await screen.findByText('Import finished', {}, { timeout: 6000 })).toBeInTheDocument();
  }, 20_000);

  it('staff cannot import', async () => {
    signedIn('staff');
    renderApp(<AppRoutes />, { route: '/products/import' });
    expect(await screen.findByText('Importing isn’t part of your role', {}, SLOW)).toBeInTheDocument();
  });
});

describe('Customers', () => {
  it('formats phones and passes the search through', async () => {
    const queries: string[] = [];
    signedIn('owner', {
      'GET /stores/S1/customers': () => jsonResponse(200, { data: [customer()], meta: { current_page: 1, per_page: 25, total: 1, last_page: 1, counts: { all: 1, new_this_month: 0 } } }),
    });
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL][] } };
    renderApp(<AppRoutes />, { route: '/customers' });
    expect(await screen.findByText('+880 1556-120987', {}, SLOW)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search customers'), '0155');
    await waitFor(() => {
      for (const [u] of fetchMock.mock.calls) queries.push(new URL(String(u), 'http://localhost').searchParams.get('q') ?? '');
      expect(queries).toContain('0155');
    });
  });

  it('detail page: WhatsApp link, notes and staff cannot delete', async () => {
    signedIn('staff', { 'GET /stores/S1/customers/CU1': jsonResponse(200, { data: customer({ notes: [{ id: 'N1', body: 'Call before shipping', author: { id: 'U1', name: 'Rahim' }, created_at: '2026-11-12T00:00:00Z', can_delete: true }] }) }) });
    renderApp(<AppRoutes />, { route: '/customers/CU1' });
    expect(await screen.findByRole('heading', { name: 'Farhana Rahman' }, SLOW)).toBeInTheDocument();
    const wa = screen.getAllByRole('link', { name: 'WhatsApp' })[0]!;
    expect(wa).toHaveAttribute('href', 'https://wa.me/8801556120987');
    expect(wa).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Call before shipping')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('Dashboard', () => {
  it('shows order empty states and real catalog numbers', async () => {
    signedIn('owner', { 'GET /stores/S1/dashboard': jsonResponse(200, { data: dashboard({ products: { total: 12, active: 9, draft: 3, archived: 0, limit: 100 }, inventory: { low_stock_variants: 4, out_of_stock_variants: 2, units_on_hand: 80, stock_value_cost_amount: null }, setup: { has_products: true } }) }) });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('Mugdho Fashion · 12 products, 4 low on stock, 2 out of stock', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByText('No sales yet')).toBeInTheDocument();
    expect(screen.getAllByText('Starts with your first order').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('link', { name: /Restock products/ })).toHaveAttribute('href', '/inventory?stock=low,out');
    const checklist = await screen.findByRole('region', { name: 'Setup checklist' });
    await waitFor(() => expect(within(checklist).getByText('Add products').closest('button')?.textContent ?? within(checklist).getByText('Add products').parentElement?.textContent).toBeTruthy());
    expect(within(checklist).getByText('2 of 8 done')).toBeInTheDocument();
  });

  it('"Add products" is a to-do linking to onboarding 05 when the shop is empty', async () => {
    signedIn('owner', { 'GET /stores/S1/dashboard': jsonResponse(200, { data: dashboard() }) });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByRole('link', { name: /Add your first product/ }, SLOW)).toBeInTheDocument();
    const checklist = await screen.findByRole('region', { name: 'Setup checklist' });
    await userEvent.click(within(checklist).getByText('Add products'));
    expect(await screen.findByRole('heading', { name: 'Add your first products' }, SLOW)).toBeInTheDocument();
  });
});

describe('Onboarding 05', () => {
  it('creates a variable product from size chips and resets the form', async () => {
    let body: { options: unknown; variants: unknown[]; status: string } | null = null;
    signedIn('owner', {
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'POST /stores/S1/products': (init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse(201, { data: product({ name: 'Kids Kurti', price_min_amount: 95000 }) });
      },
    });
    renderApp(<AppRoutes />, { route: '/onboarding/products' });
    fireEvent.change(await screen.findByLabelText('Product name', {}, SLOW), { target: { value: 'Kids Kurti' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '950' } });
    await userEvent.click(screen.getByRole('button', { name: 'M' }));
    await userEvent.click(screen.getByRole('button', { name: 'L' }));
    expect(screen.getByLabelText('Stock per size')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Stock per size'), { target: { value: '5' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add another product' }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.status).toBe('active');
    expect(body!.options).toEqual([{ name: 'Size', values: ['M', 'L'] }]);
    expect(body!.variants).toHaveLength(2);
    await waitFor(() => expect(screen.getByLabelText('Product name')).toHaveValue(''));
    expect(screen.getByText('Kids Kurti is live')).toBeInTheDocument();
    expect(screen.getByText('Product 2 of 3')).toBeInTheDocument();
  });
});
