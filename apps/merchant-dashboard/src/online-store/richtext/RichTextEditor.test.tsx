import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RichTextEditor from './RichTextEditor';

// QA P89D-QA-B1: loading an empty field must not report a change (product editor showed "Unsaved changes" on load).
describe('RichTextEditor', () => {
  it.each([false, true])('does not call onChange on mount with a null value (disabled=%s)', async (disabled) => {
    const onChange = vi.fn();
    render(<RichTextEditor value={null} onChange={onChange} label="Description" disabled={disabled} />);
    expect(await screen.findByRole('textbox', { name: 'Description' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).not.toHaveBeenCalled();
  });
});
