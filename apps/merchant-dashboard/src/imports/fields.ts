import type { CustomerImportField, DataImport, DataImportType, ImportField, ProductImportField, SupplierImportField } from '@storeplix/types';

// Contract §5.2 / §5.3 field labels (WEB mirrors the API's column spec) and the wizard's pure state helpers.

export const productFieldLabels: Record<ProductImportField, string> = {
  handle: 'URL handle',
  name: 'Product name',
  description: 'Description',
  status: 'Status',
  category: 'Category',
  tags: 'Tags',
  option1_name: 'Option 1 name',
  option1_value: 'Option 1 value',
  option2_name: 'Option 2 name',
  option2_value: 'Option 2 value',
  option3_name: 'Option 3 name',
  option3_value: 'Option 3 value',
  sku: 'SKU',
  barcode: 'Barcode',
  price: 'Price',
  compare_at_price: 'Compare-at price',
  cost_price: 'Cost per item',
  stock: 'Stock quantity',
  weight_kg: 'Weight (kg)',
  seo_title: 'SEO title',
  seo_description: 'SEO description',
  image_urls: 'Photos (links)',
};

export const customerFieldLabels: Record<CustomerImportField, string> = {
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  district: 'District',
  area: 'Area',
  channel: 'Came from',
  tags: 'Tags',
  accepts_marketing: 'Accepts marketing',
  note: 'Note',
};

/** PHASE-8-8B P88B-15 supplier columns. */
export const supplierFieldLabels: Record<SupplierImportField, string> = {
  name: 'Supplier name',
  contact_name: 'Contact person',
  phone: 'Phone',
  city: 'City / area',
  supplies: 'What they supply',
  payment_terms_days: 'Payment terms (days)',
  lead_time_days: 'Lead time (days)',
  pays_by_method: 'Pay by',
  pays_by_account: 'Pay to (account)',
  notes: 'Notes',
};

export function fieldLabels(type: DataImportType): Record<string, string> {
  return type === 'products' ? productFieldLabels : type === 'suppliers' ? supplierFieldLabels : customerFieldLabels;
}

/** `?type=` → import type (unknown → products). */
export function importTypeOf(raw: string | null): DataImportType {
  return raw === 'customers' || raw === 'suppliers' ? raw : 'products';
}

/** Copy per import type: plural noun, singular noun, back link, back label, page description, update-existing labels. */
export function importCopy(type: DataImportType) {
  switch (type) {
    case 'products':
      return { noun: 'products', one: 'product', back: '/products', backLabel: 'Products', intro: 'Bring products from a spreadsheet, Shopify or WooCommerce export.', updateRow: 'Update existing (same SKU)', updateOpt: 'Update products with the same SKU', updateHint: 'Price, stock and details are replaced' };
    case 'customers':
      return { noun: 'customers', one: 'customer', back: '/customers', backLabel: 'Customers', intro: 'Bring customers from a spreadsheet or your old shop.', updateRow: 'Update existing (same phone/email)', updateOpt: 'Update customers with the same phone', updateHint: 'Filled cells replace current details' };
    case 'suppliers':
      return { noun: 'suppliers', one: 'supplier', back: '/inventory/suppliers', backLabel: 'Suppliers', intro: 'Bring your supplier list from a spreadsheet.', updateRow: 'Update existing (same phone or name)', updateOpt: 'Update suppliers with the same phone or name', updateHint: 'Filled cells replace current details' };
  }
}

export type ColumnMap = Record<string, ImportField | null>;

/** Client mirror of the validate-step 422 rules: required fields mapped, no field mapped twice. */
export function columnMapErrors(type: DataImportType, map: ColumnMap): string[] {
  const errors: string[] = [];
  const used = new Map<string, string>();
  for (const [header, field] of Object.entries(map)) {
    if (!field) continue;
    if (used.has(field)) errors.push(`“${fieldLabels(type)[field]}” is matched to both “${used.get(field)}” and “${header}”.`);
    used.set(field, header);
  }
  const mapped = new Set(Object.values(map).filter(Boolean));
  if (type === 'products') {
    if (!mapped.has('name')) errors.push('Match a column to Product name.');
    if (!mapped.has('price')) errors.push('Match a column to Price.');
  } else if (type === 'suppliers') {
    if (!mapped.has('name')) errors.push('Match a column to Supplier name.');
  } else {
    if (!mapped.has('name')) errors.push('Match a column to Name.');
    if (!mapped.has('phone') && !mapped.has('email')) errors.push('Match a column to Phone or Email.');
  }
  return errors;
}

export type WizardStep = 'upload' | 'map' | 'validating' | 'review' | 'importing' | 'done' | 'failed';

/** Import status → wizard screen (upload → map → dry-run → review → run → report). */
export function wizardStep(imp: Pick<DataImport, 'status'> | null | undefined): WizardStep {
  switch (imp?.status) {
    case undefined:
    case 'cancelled':
      return 'upload';
    case 'uploaded':
      return 'map';
    case 'validating':
      return 'validating';
    case 'validated':
      return 'review';
    case 'importing':
      return 'importing';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
  }
}

/** Poll every 2 s only while the queue is working (contract §9.2). */
export function pollInterval(imp: Pick<DataImport, 'status'> | null | undefined): number | false {
  return imp && (imp.status === 'validating' || imp.status === 'importing') ? 2000 : false;
}
