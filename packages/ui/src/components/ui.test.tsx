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
