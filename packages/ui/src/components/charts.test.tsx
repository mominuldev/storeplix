import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BarChart, DonutMeter, LineChart, niceCeil, StackedMeter, thinIndexes } from './Charts';

describe('chart helpers', () => {
  it('niceCeil rounds up to 1 / 2 / 2.5 / 5 × 10ⁿ', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(37)).toBe(50);
    expect(niceCeil(31400)).toBe(50000);
    expect(niceCeil(1800)).toBe(2000);
    expect(niceCeil(2400)).toBe(2500);
    expect(niceCeil(100)).toBe(100);
  });
  it('thinIndexes keeps first and last and caps the count', () => {
    expect(thinIndexes(3, 7)).toEqual([0, 1, 2]);
    const idx = thinIndexes(30, 7);
    expect(idx).toHaveLength(7);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(29);
    expect(thinIndexes(0, 7)).toEqual([]);
  });
});

describe('charts render accessible tables', () => {
  it('LineChart', () => {
    render(<LineChart caption="Sales per day" labels={['1 Nov', '2 Nov']} series={[{ name: 'Sales', values: [100, null], area: true }]} formatValue={(n) => `৳${n}`} />);
    const table = screen.getByRole('table', { name: 'Sales per day' });
    expect(within(table).getByRole('rowheader', { name: '1 Nov' })).toBeInTheDocument();
    expect(within(table).getByText('৳100')).toBeInTheDocument();
    expect(within(table).getByText('—')).toBeInTheDocument();
  });
  it('BarChart shows notes for untracked bars', () => {
    render(<BarChart caption="Waterfall" bars={[{ label: 'Revenue', value: 500, display: '৳ 5' }, { label: 'Gateway fees', value: null, note: 'Not tracked' }]} />);
    const table = screen.getByRole('table', { name: 'Waterfall' });
    expect(within(table).getByText('৳ 5')).toBeInTheDocument();
    expect(within(table).getAllByText('Not tracked').length).toBeGreaterThan(0);
  });
  it('StackedMeter and DonutMeter list each share', () => {
    render(
      <>
        <StackedMeter caption="Split" segments={[{ label: 'Inside', value: 1, tone: 'brand' }, { label: 'Outside', value: 3, tone: 'accent' }]} />
        <DonutMeter caption="Channels" centerValue="4" segments={[{ label: 'Facebook', value: 3, tone: 'brand', display: '75%' }, { label: 'Website', value: 0, tone: 'info' }]} />
      </>,
    );
    expect(within(screen.getByRole('table', { name: 'Split' })).getByText('25%')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Channels' })).getByText('75%')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Channels' })).getByText('0%')).toBeInTheDocument();
  });
});
