import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { AreaPicker, type AreaValue } from './AreaPicker';
import { bpsToInput, parsePercent } from '../lib/percent';
import { PercentInput } from './PercentInput';
import { OrderStatusBadge, PaymentStatusBadge } from './StatusBadge';
import { Timeline } from './Timeline';

describe('Phase 5 UI', () => {
  it('order and payment badges use the Figma labels', () => {
    render(
      <>
        <OrderStatusBadge status="shipped" />
        <PaymentStatusBadge status="partially_refunded" />
      </>,
    );
    expect(screen.getByText('In transit')).toBeInTheDocument();
    expect(screen.getByText('Partly refunded')).toBeInTheDocument();
  });

  it('parsePercent converts to basis points within 1–100 %', () => {
    expect(parsePercent('15')).toBe(1500);
    expect(parsePercent('12.5')).toBe(1250);
    expect(parsePercent('০.০১')).toBe(1);
    expect(parsePercent('')).toBeNull();
    expect(parsePercent('101')).toBeNaN();
    expect(parsePercent('1.234')).toBeNaN();
    expect(bpsToInput(1250)).toBe('12.5');
  });

  it('PercentInput emits bps', () => {
    let out: number | null = null;
    render(<PercentInput label="Discount" value={null} onChange={(v) => (out = v)} />);
    fireEvent.change(screen.getByLabelText('Discount'), { target: { value: '20' } });
    expect(out).toBe(2000);
  });

  it('Timeline renders entries in order', () => {
    render(<Timeline items={[{ id: '1', title: 'Order placed' }, { id: '2', title: 'Confirmed', detail: 'by Rahim' }]} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent('by Rahim');
  });

  it('AreaPicker selects districts and thanas and disables taken areas', () => {
    function Harness() {
      const [v, setV] = useState<AreaValue[]>([]);
      return (
        <>
          <AreaPicker
            districts={[
              { code: 'dhaka', name: 'Dhaka', thanas: [{ code: 'dhaka-mirpur', name: 'Mirpur' }, { code: 'dhaka-gulshan', name: 'Gulshan' }] },
              { code: 'gazipur', name: 'Gazipur', thanas: [] },
            ]}
            value={v}
            onChange={setV}
            taken={{ gazipur: 'Dhaka suburbs', 'dhaka:dhaka-gulshan': 'Inside Dhaka' }}
          />
          <output>{JSON.stringify(v)}</output>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('checkbox', { name: /Gazipur/ })).toBeDisabled();
    expect(screen.getByText('In Dhaka suburbs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show thanas in Dhaka' }));
    expect(screen.getByRole('checkbox', { name: /Gulshan/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Mirpur/ }));
    expect(screen.getByRole('status').textContent).toBe(JSON.stringify([{ district_code: 'dhaka', thana_code: 'dhaka-mirpur' }]));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No district or thana matches/)).toBeInTheDocument();
  });
});
