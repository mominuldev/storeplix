import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ChipSelect,
  DataTable,
  Dialog,
  FileDrop,
  flattenTree,
  formatBdt,
  getProjection,
  MoneyInput,
  moneyToInput,
  Pagination,
  parseMoney,
  StockBadge,
  Stepper,
  TagInput,
  Tabs,
  validParentIds,
} from '../index';

describe('money', () => {
  it('parses major units to paisa with integer maths', () => {
    expect(parseMoney('3450')).toBe(345000);
    expect(parseMoney('3,450.5')).toBe(345050);
    expect(parseMoney('৳ 3,450.50')).toBe(345050);
    expect(parseMoney('৩৪৫০')).toBe(345000);
    expect(parseMoney('950tk')).toBe(95000);
    expect(parseMoney('0.29')).toBe(29);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('3450.555')).toBeNaN();
    expect(parseMoney('-5')).toBeNaN();
    expect(parseMoney('abc')).toBeNaN();
    expect(parseMoney('123456789')).toBeNaN();
  });

  it('formats paisa for display and editing', () => {
    expect(formatBdt(345000)).toBe('৳ 3,450');
    expect(formatBdt(345050)).toBe('৳ 3,450.50');
    expect(formatBdt(18420000)).toBe('৳ 1,84,200');
    expect(formatBdt(null)).toBe('—');
    expect(moneyToInput(345050)).toBe('3450.50');
    expect(moneyToInput(345000)).toBe('3450');
    expect(moneyToInput(null)).toBe('');
  });

  it('MoneyInput emits paisa, null and NaN', () => {
    const onChange = vi.fn();
    render(<MoneyInput label="Price" value={null} onChange={onChange} />);
    const input = screen.getByLabelText('Price');
    fireEvent.change(input, { target: { value: '1,850' } });
    expect(onChange).toHaveBeenLastCalledWith(185000);
    fireEvent.change(input, { target: { value: '1.234' } });
    expect(onChange).toHaveBeenLastCalledWith(Number.NaN);
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('Tabs and StockBadge', () => {
  it('shows counts and switches tabs', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        aria-label="Status"
        value="all"
        onChange={onChange}
        items={[
          { value: 'all', label: 'All', count: 102 },
          { value: 'draft', label: 'Draft', count: 12 },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: /^All\s*102$/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /^Draft\s*12$/ }));
    expect(onChange).toHaveBeenCalledWith('draft');
  });

  it('maps stock statuses to labels', () => {
    render(<StockBadge status="out_of_stock" />);
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  const rows = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
  ];
  function Harness({ onBulk }: { onBulk?: () => void }) {
    const [sel, setSel] = useState<string[]>([]);
    return (
      <DataTable
        label="Products"
        rows={rows}
        getRowId={(r) => r.id}
        rowLabel={(r) => r.name}
        columns={[{ key: 'name', header: 'Product', cell: (r) => r.name, mobileLabel: false }]}
        selected={sel}
        onSelectedChange={setSel}
        bulkActions={<button onClick={onBulk}>Archive</button>}
      />
    );
  }

  it('selects rows, shows the bulk bar and select-all is indeterminate', () => {
    render(<Harness />);
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toHaveAttribute('aria-checked', 'mixed');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('without selection props renders no checkboxes', () => {
    render(<DataTable label="T" rows={rows} getRowId={(r) => r.id} columns={[{ key: 'n', header: 'Name', cell: (r) => r.name }]} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('Pagination shows the range and disables edges', () => {
    const onPage = vi.fn();
    render(<Pagination page={1} perPage={25} total={102} lastPage={5} noun="products" onPage={onPage} />);
    expect(screen.getByText('Showing 1–25 of 102 products')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });
});

describe('inputs', () => {
  it('TagInput normalises, dedupes and removes', () => {
    function H() {
      const [tags, setTags] = useState<string[]>(['eid']);
      return <TagInput label="Tags" value={tags} onChange={setTags} />;
    }
    render(<H />);
    const input = screen.getByLabelText('Tags');
    fireEvent.change(input, { target: { value: ' Jamdani , EID' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('jamdani')).toBeInTheDocument();
    expect(screen.getAllByText('eid')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove eid' }));
    expect(screen.queryByText('eid')).toBeNull();
  });

  it('ChipSelect toggles and adds custom values', () => {
    function H() {
      const [v, setV] = useState<string[]>([]);
      return (
        <>
          <ChipSelect aria-label="Sizes" options={['S', 'M'].map((value) => ({ value }))} value={v} onChange={setV} allowCustom />
          <output>{v.join('|')}</output>
        </>
      );
    }
    render(<H />);
    fireEvent.click(screen.getByRole('button', { name: 'M' }));
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    const input = screen.getByLabelText('Add value');
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('M|40')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '40' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('FileDrop rejects files over maxBytes', () => {
    const onFiles = vi.fn();
    render(<FileDrop label="Upload CSV" accept=".csv" maxBytes={4} tooLargeMessage="Too big" onFiles={onFiles} />);
    fireEvent.change(screen.getByLabelText('Upload CSV'), { target: { files: [new File(['12345'], 'a.csv')] } });
    expect(screen.getByRole('alert')).toHaveTextContent('Too big');
    fireEvent.change(screen.getByLabelText('Upload CSV'), { target: { files: [new File(['1'], 'b.csv')] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it('Stepper marks the current step', () => {
    render(
      <Stepper
        steps={[
          { title: 'Upload file', state: 'done' },
          { title: 'Match columns', state: 'current' },
          { title: 'Import', state: 'upcoming' },
        ]}
      />,
    );
    expect(screen.getByText('Match columns').closest('li')).toHaveAttribute('aria-current', 'step');
  });

  it('Dialog submits a form when formId is set', () => {
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    const onConfirm = vi.fn();
    render(
      <Dialog open title="Add" confirmLabel="Save" formId="f" onConfirm={onConfirm} onCancel={() => {}}>
        <form id="f" onSubmit={onSubmit} />
      </Dialog>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save', hidden: true }));
    expect(onSubmit).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('SortableTree depth 3 (maxDepth = 2)', () => {
  type N = { id: string; children?: N[] };
  const tree: N[] = [{ id: 'a', children: [{ id: 'a1', children: [{ id: 'a11' }] }] }, { id: 'b', children: [{ id: 'b1' }] }, { id: 'c' }];

  it('validParentIds excludes self, descendants and too-deep targets', () => {
    // c (leaf) can go under anything at depth ≤ 1.
    expect(validParentIds(tree, 'c', 2)).toEqual(['a', 'a1', 'b', 'b1']);
    // b has height 1 → only root-level parents.
    expect(validParentIds(tree, 'b', 2)).toEqual(['a', 'c']);
    // a can't move under its own descendants; height 2 → nowhere but top level.
    expect(validParentIds(tree, 'a', 2)).toEqual([]);
  });

  it('projection never nests a third level deeper', () => {
    const flat = flattenTree(tree);
    // dragging c right twice under a11 would be depth 3 → clamped to 2.
    expect(getProjection(flat, 'c', 'c', 5, 2).depth).toBeLessThanOrEqual(2);
  });
});
