import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, Button, Input, Logo } from '../index';

describe('@storeplix/ui', () => {
  it('Button applies Figma variant classes and disables while loading', () => {
    render(
      <Button variant="danger" loading>
        Delete
      </Button>,
    );
    const button = screen.getByRole('button', { name: /delete/i });
    expect(button).toHaveClass('bg-danger');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('Input links label and error message accessibly', () => {
    render(<Input label="Email" error="Required" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Required');
  });

  it('Badge renders status tone', () => {
    render(<Badge tone="success">Active</Badge>);
    expect(screen.getByText('Active')).toHaveClass('bg-success-bg', 'text-success');
  });

  it('Logo keeps the SVG aspect ratio', () => {
    render(<Logo height={28} />);
    const img = screen.getByAltText('Storeplix');
    expect(img).toHaveAttribute('height', '28');
    expect(img).toHaveAttribute('width', '70');
  });
});

import { Chip, Step } from '../index';

describe('onboarding components', () => {
  it('Chip exposes selection via aria-pressed', () => {
    render(<Chip selected>Fashion</Chip>);
    expect(screen.getByRole('button', { name: 'Fashion' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Step marks the current step', () => {
    render(<Step index={3} title="Name your shop" state="current" />);
    expect(screen.getByText('Name your shop').closest('[aria-current]')).toHaveAttribute('aria-current', 'step');
  });
});

import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ChecklistItem, OtpInput, Toggle } from '../index';

function OtpHarness({ onDone }: { onDone: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <OtpInput
      value={v}
      onChange={(next) => {
        setV(next);
        onDone(next);
      }}
    />
  );
}

describe('phase 2 components', () => {
  it('OtpInput accepts a pasted code across boxes and uses the numeric keypad', () => {
    let last = '';
    render(<OtpHarness onDone={(v) => (last = v)} />);
    const first = screen.getByLabelText('Verification code digit 1');
    expect(first).toHaveAttribute('inputmode', 'numeric');
    expect(first).toHaveAttribute('autocomplete', 'one-time-code');
    fireEvent.paste(first, { clipboardData: { getData: () => '12-34 56' } });
    expect(last).toBe('123456');
    expect(screen.getByLabelText('Verification code digit 6')).toHaveValue('6');
  });

  it('Toggle is a switch', () => {
    render(<Toggle checked label="Use for returns" />);
    expect(screen.getByRole('switch', { name: 'Use for returns' })).toHaveAttribute('aria-checked', 'true');
  });

  it('ChecklistItem shows locked items as coming soon', () => {
    render(<ChecklistItem title="Pick a theme" state="locked" />);
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });
});
