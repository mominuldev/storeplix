import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RiskBadge, riskTierMeta } from './RiskBadge';

describe('RiskBadge 3:57', () => {
  it('labels and tones per tier', () => {
    expect(Object.values(riskTierMeta).map((m) => m.label)).toEqual(['Good', 'Be careful', 'Risky', 'New buyer']);
    render(
      <>
        <RiskBadge tier="good" />
        <RiskBadge tier="careful" />
        <RiskBadge tier="risky" />
        <RiskBadge tier="new" />
      </>,
    );
    expect(screen.getByText('Good')).toHaveClass('text-success');
    expect(screen.getByText('Be careful')).toHaveClass('text-warning');
    expect(screen.getByText('Risky')).toHaveClass('text-danger');
    expect(screen.getByText('New buyer')).toHaveClass('text-text-secondary');
  });
});
