import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatBdtCompact } from '../lib/money';
import { BarChart, Heatmap, heatStep } from './Charts';

describe('formatBdtCompact (Bangla lakh / crore)', () => {
  it('uses three significant digits and K / L / Cr units', () => {
    expect(formatBdtCompact(96500)).toBe('৳ 965');
    expect(formatBdtCompact(3_500_000)).toBe('৳ 35 K');
    expect(formatBdtCompact(2_760_000)).toBe('৳ 27.6 K');
    expect(formatBdtCompact(184_000_000)).toBe('৳ 18.4 L');
    expect(formatBdtCompact(2_210_000_000)).toBe('৳ 2.21 Cr');
    expect(formatBdtCompact(10_000_000)).toBe('৳ 1 L');
    expect(formatBdtCompact(200_000_000, { tight: true })).toBe('৳ 20L');
    expect(formatBdtCompact(-3_500_000, { symbol: false })).toBe('−35 K');
    expect(formatBdtCompact(null)).toBe('—');
  });
});

describe('BarChart stacked / diverging mode', () => {
  it('stacks positive segments, draws negative ones below zero and lists every segment', () => {
    const { container } = render(
      <BarChart
        caption="MRR movement"
        bars={[
          {
            label: 'Oct',
            value: null,
            display: '+76K',
            segments: [
              { label: 'New', value: 100, tone: 'brand' },
              { label: 'Expansion', value: 20, tone: 'soft' },
              { label: 'Contraction', value: -10, tone: 'warning' },
              { label: 'Churn', value: -34, tone: 'accent' },
            ],
          },
          { label: 'Nov', value: null, segments: null, note: 'No data' },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'MRR movement' });
    expect(within(table).getByRole('columnheader', { name: 'Churn' })).toBeInTheDocument();
    expect(within(table).getByText('-34')).toBeInTheDocument();
    expect(within(table).getByText('+76K')).toBeInTheDocument();
    expect(within(table).getAllByText('No data').length).toBeGreaterThan(0);
    // Negative segments sit below the zero line (their bottom is under the zero offset).
    const churn = container.querySelector<HTMLElement>('[data-segment="Churn"]')!;
    const fresh = container.querySelector<HTMLElement>('[data-segment="New"]')!;
    expect(parseFloat(churn.style.bottom)).toBeLessThan(parseFloat(fresh.style.bottom));
    expect(container.querySelectorAll('[data-empty]')).toHaveLength(1);
    expect(container.querySelector('[data-empty]')).toHaveAttribute('title', 'No data');
  });

  it('thinned x axis (30 daily bars): labels do not wrap and null notes stay in the tooltip only (P82-QA-2)', () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ label: `${i + 1} Nov`, value: null, segments: null, note: 'No data' }));
    const { container } = render(<BarChart caption="MRR by plan" bars={bars} maxXLabels={12} series={['Starter']} />);
    const empty = container.querySelectorAll('[data-empty]');
    expect(empty).toHaveLength(30);
    expect(empty[0]).toHaveAttribute('title', 'No data');
    expect(empty[0]!.textContent).toBe('');
    const shown = within(container).getByText('1 Nov', { selector: 'span' });
    expect(shown.className).toContain('whitespace-nowrap');
  });
});

describe('Heatmap', () => {
  it('maps values to five steps', () => {
    expect(heatStep(0.5)).toBe(0);
    expect(heatStep(0.65)).toBe(1);
    expect(heatStep(0.75)).toBe(2);
    expect(heatStep(0.85)).toBe(3);
    expect(heatStep(1)).toBe(4);
  });
  it('renders a table with empty cells for null and missing values', () => {
    render(
      <Heatmap
        caption="Cohort retention"
        columns={['M0', 'M1', 'M2']}
        asideHeader="Shops"
        rows={[
          { key: 'a', label: 'Jan 2026', aside: 168, values: [1, 0.8, null] },
          { key: 'b', label: 'Feb 2026', aside: 174, values: [1] },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Cohort retention' });
    const jan = within(table).getByRole('row', { name: /Jan 2026/ });
    expect(within(jan).getByText('80%')).toBeInTheDocument();
    expect(within(table).getAllByLabelText('No data')).toHaveLength(3);
  });
});
