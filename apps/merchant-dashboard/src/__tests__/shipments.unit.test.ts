import { describe, expect, it } from 'vitest';
import { batchReasonLabel, codCell, manifestCsv, renderDescription, trackingSteps } from '../shipments/labels';
import { order } from './phase5.fixtures';
import { shipmentSummary } from './shipments.fixtures';

// Phase 5b-3 shipment helpers (PHASE-5B §10, P5B-36/40/43).

describe('codCell (39:10347 COD column)', () => {
  it('to collect / collected / won’t collect / paid online', () => {
    expect(codCell({ status: 'in_transit', cod_amount: 177_000, cod_collected_amount: null })).toEqual({ amount: 177_000, label: 'To collect', tone: 'muted' });
    expect(codCell({ status: 'delivered', cod_amount: 177_000, cod_collected_amount: 165_000 })).toEqual({ amount: 165_000, label: 'Collected', tone: 'muted' });
    expect(codCell({ status: 'returning', cod_amount: 420_000, cod_collected_amount: null })).toMatchObject({ label: 'Won’t collect', tone: 'danger' });
    expect(codCell({ status: 'delivered', cod_amount: 0, cod_collected_amount: 0 }).label).toBe('Paid online');
  });
});

describe('trackingSteps (146:33100 stepper)', () => {
  it('marks steps up to the current one', () => {
    expect(trackingSteps('out_for_delivery').map((s) => s.state)).toEqual(['done', 'done', 'done', 'current', 'upcoming']);
    expect(trackingSteps('delivered').every((s) => s.state === 'done')).toBe(true);
  });
  it('shows off-path states in place of the step', () => {
    const steps = trackingSteps('returned');
    expect(steps[4]).toEqual({ title: 'Returned', state: 'current' });
    expect(trackingSteps('on_hold')[3]!.title).toBe('On hold');
  });
});

describe('bulk reasons and templates', () => {
  it('area_unmapped points to the order', () => {
    expect(batchReasonLabel('area_unmapped', 'pathao')).toMatch(/Area needs mapping .* Pathao area/);
    expect(batchReasonLabel('something_new', 'redx')).toBe('something_new');
  });
  it('renders {items} and {order_no} up to 120 chars', () => {
    expect(renderDescription('{items} · {order_no}', order())).toBe('Cotton Panjabi · MU-1042');
    expect(renderDescription('{items}'.repeat(20), order())).toHaveLength(120);
  });
});

describe('manifestCsv', () => {
  it('quotes cells, neutralises formulas and writes COD in taka', () => {
    const csv = manifestCsv([shipmentSummary({ order: { id: 'O1', number: 'MU-1', customer_name: '=HYPERLINK("x")', customer_phone: '8801712345678', district: 'Dhaka', thana: 'Mirpur' } })]);
    const [head, row] = csv.split('\r\n');
    expect(head).toBe('"Consignment","Order","Customer","Phone","Area","Courier","Status","COD (BDT)"');
    expect(row).toContain('"\'=HYPERLINK(""x"")"');
    expect(row).toContain('"1770.00"');
  });
});
