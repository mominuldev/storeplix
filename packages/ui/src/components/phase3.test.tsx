import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildTree, ColorSwatch, contrastRatio, Dialog, DraftBar, flattenTree, getProjection, Menu, moveTreeNode, SegmentedControl, SortableList, gripProps } from '../index';

type N = { id: string; children?: N[] };
const tree: N[] = [{ id: 'a', children: [{ id: 'a1' }, { id: 'a2' }] }, { id: 'b' }, { id: 'c' }];

describe('tree helpers', () => {
  it('flatten → build round-trips', () => {
    const flat = flattenTree(tree);
    expect(flat.map((f) => `${f.id}:${f.depth}:${f.parentId}`)).toEqual(['a:0:null', 'a1:1:a', 'a2:1:a', 'b:0:null', 'c:0:null']);
    expect(buildTree(flat)).toEqual(tree);
  });

  it('nests b under a when dragged right, but never deeper than maxDepth', () => {
    const flat = flattenTree(tree);
    expect(getProjection(flat, 'b', 'b', 1, 1)).toEqual({ depth: 1, parentId: 'a' });
    // a2 is already depth 1; dragging c right over b can go at most to depth 1 (b is root).
    expect(getProjection(flat, 'c', 'c', 5, 1)).toEqual({ depth: 1, parentId: 'b' });
  });

  it('a parent with children cannot be nested when maxDepth is 1', () => {
    const flat = flattenTree([{ id: 'x' }, ...tree]);
    expect(getProjection(flat, 'a', 'a', 1, 1)).toEqual({ depth: 0, parentId: null });
  });

  it('moveTreeNode moves a subtree and re-parents', () => {
    const moved = moveTreeNode(tree, 'a', 'c', { depth: 0, parentId: null });
    expect(moved.map((n) => n.id)).toEqual(['b', 'c', 'a']);
    expect(moved[2]!.children?.map((n) => n.id)).toEqual(['a1', 'a2']);
    const nested = moveTreeNode(tree, 'c', 'b', { depth: 1, parentId: 'b' });
    expect(nested.find((n) => n.id === 'b')!.children?.map((n) => n.id)).toEqual(['c']);
    const unnested = moveTreeNode(tree, 'a2', 'a2', { depth: 0, parentId: null });
    expect(unnested.map((n) => n.id)).toEqual(['a', 'a2', 'b', 'c']);
  });
});

describe('Phase 3 components', () => {
  it('contrastRatio matches WCAG examples', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#5b53ff', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio('red', '#ffffff')).toBe(1);
  });

  it('ColorSwatch is a pressed toggle and ignores non-hex colours', () => {
    render(<ColorSwatch color="url(x)" label="Violet" selected />);
    const b = screen.getByRole('button', { name: 'Violet' });
    expect(b).toHaveAttribute('aria-pressed', 'true');
    expect(b.style.backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('DraftBar and Dialog render actions', () => {
    const onConfirm = vi.fn();
    render(
      <>
        <DraftBar title="2 changes in draft" actions={<button type="button">Publish</button>} />
        <Dialog open title="Discard?" confirmLabel="Discard" tone="danger" onConfirm={onConfirm} onCancel={() => {}} />
      </>,
    );
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('2 changes in draft');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('Menu opens, runs an item and skips disabled ones', () => {
    const dup = vi.fn();
    render(
      <Menu
        label="Section actions"
        trigger="…"
        entries={[
          { key: 'up', label: 'Move up', disabled: true, onSelect: () => {} },
          { key: 'dup', label: 'Duplicate', onSelect: dup },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Section actions' }));
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(dup).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('SegmentedControl sm can be disabled', () => {
    render(<SegmentedControl size="sm" disabled aria-label="Device" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }]} />);
    expect(screen.getByRole('tab', { name: 'A' })).toBeDisabled();
  });

  it('SortableList renders grip handles with dnd-kit keyboard attributes', () => {
    render(
      <SortableList
        label="Sections"
        items={[{ id: 'x' }, { id: 'y' }]}
        onMove={() => {}}
        renderItem={(item, { handle }) => (
          <button type="button" aria-label={`Drag ${item.id}`} {...gripProps(handle)}>
            ⋮
          </button>
        )}
      />,
    );
    expect(screen.getByRole('list', { name: 'Sections' }).children).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Drag x' })).toHaveAttribute('aria-roledescription', 'sortable');
  });
});
