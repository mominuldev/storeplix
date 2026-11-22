import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { shipmentStatusMeta, type ShipmentStatus } from '../lib/status';
import { ShipmentStatusBadge } from './StatusBadge';

// Phase 5b-3 Shipments 39:10347 status badge.
describe('ShipmentStatusBadge', () => {
  it('labels every status and tolerates unknown ones', () => {
    render(<ShipmentStatusBadge status="delivery_failed" />);
    expect(screen.getByText('Failed attempt')).toBeInTheDocument();
    render(<ShipmentStatusBadge status={'agent_area_change' as ShipmentStatus} />);
    expect(screen.getByText('agent area change')).toBeInTheDocument();
    expect(Object.keys(shipmentStatusMeta)).toHaveLength(14);
  });
});
