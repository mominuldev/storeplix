import type { CustomerImportField, DataImport, DataImportType, ImportField, ProductImportField } from '@storeplix/types';

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

export function fieldLabels(type: DataImportType): Record<string, string> {
  return type === 'products' ? productFieldLabels : customerFieldLabels;
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
