import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChoiceCard } from './ChoiceCard';

describe('ChoiceCard (Figma 39:4640)', () => {
  it('is a labelled radio with detail and value; selected uses the 2px brand border', () => {
    const onChange = vi.fn();
    render(
      <div>
        <ChoiceCard name="ch" value="sms" title="SMS" detail="Reaches every phone" aside="980 left" checked onChange={onChange} />
        <ChoiceCard name="ch" value="email" title="Email" detail="Your logo + text" aside="5,000 left" checked={false} onChange={onChange} />
      </div>,
    );
    const sms = screen.getByRole('radio', { name: /SMS/ });
    const email = screen.getByRole('radio', { name: /Email/ });
    expect(sms).toBeChecked();
    expect(email).not.toBeChecked();
    expect(sms.closest('label')).toHaveClass('border-2', 'border-brand-600', 'bg-brand-50');
    expect(email.closest('label')).toHaveClass('border', 'border-border-default');
    expect(screen.getByText('980 left')).toBeInTheDocument();
    fireEvent.click(email);
    expect(onChange).toHaveBeenCalled();
  });

  it('disabled cards cannot be chosen', () => {
    render(<ChoiceCard name="x" value="a" title="A" disabled checked={false} onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'A' })).toBeDisabled();
  });
});
