import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyValue } from './CopyValue';
import { DnsRecordStatusBadge, DomainStatusBadge } from './StatusBadge';

afterEach(() => vi.unstubAllGlobals());

describe('Phase 6 UI', () => {
  it('DomainStatusBadge maps every state to the contract label', () => {
    const { rerender } = render(<DomainStatusBadge status="pending_verification" />);
    expect(screen.getByText('Waiting for DNS')).toBeInTheDocument();
    for (const [s, label] of [
      ['verified', 'Securing'],
      ['ssl_provisioning', 'Securing'],
      ['active', 'Connected'],
      ['verification_failed', 'Failed'],
      ['expired', 'Disconnected'],
      ['suspended', 'Suspended'],
    ] as const) {
      rerender(<DomainStatusBadge status={s} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('DnsRecordStatusBadge shows a symbol and label', () => {
    render(
      <>
        <DnsRecordStatusBadge status="ok" />
        <DnsRecordStatusBadge status="mismatch" />
        <DnsRecordStatusBadge status="missing" />
      </>,
    );
    expect(screen.getByText('Found')).toBeInTheDocument();
    expect(screen.getByText('Doesn’t match').parentElement).toHaveTextContent('≠');
    expect(screen.getByText('Not found yet').parentElement).toHaveTextContent('✗');
  });

  it('CopyValue copies the value and confirms', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onCopied = vi.fn();
    render(<CopyValue value="sp-verify=abc" label="Copy TXT value" onCopied={onCopied} />);
    expect(screen.getByText('sp-verify=abc')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy TXT value' }));
    await waitFor(() => expect(onCopied).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith('sp-verify=abc');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});
