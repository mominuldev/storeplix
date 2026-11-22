import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CopyField } from './CopyField';
import { ProviderLogo } from './ProviderLogo';
import { SecretField } from './SecretField';

function Secret({ hint }: { hint?: string | null }) {
  const [v, setV] = useState('');
  return <SecretField id="s" label="App secret" value={v} onChange={setV} savedHint={hint} />;
}

describe('Phase 5b UI', () => {
  it('SecretField is a password field that never pre-fills and shows the saved hint as placeholder', () => {
    render(<Secret hint="••••3f9a" />);
    const input = screen.getByLabelText('App secret') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(input.placeholder).toContain('••••3f9a');
    fireEvent.change(input, { target: { value: 'typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show App secret' }));
    expect(input.type).toBe('text');
  });

  it('ProviderLogo renders the bKash wordmark and image marks', () => {
    const { container } = render(
      <>
        <ProviderLogo provider="bkash" label="bKash" />
        <ProviderLogo provider="sslcommerz" />
      </>,
    );
    expect(screen.getByRole('img', { name: 'bKash' })).toHaveTextContent('bKash');
    expect(container.querySelector('img')?.getAttribute('src')).toContain('sslcommerz');
  });

  it('CopyField copies its value', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onCopied = vi.fn();
    render(<CopyField label="Link" value="https://shop.test/pay/abc" onCopied={onCopied} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledWith('https://shop.test/pay/abc');
    expect(onCopied).toHaveBeenCalled();
  });
});
