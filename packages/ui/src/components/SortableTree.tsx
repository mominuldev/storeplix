import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import type { SortableHandleProps } from './SortableList';

// Figma V3 Navigation 2037:46512 tree editor: drag to reorder, drag right onto a link to nest, left to un-nest.
// Depth is limited by `maxDepth` (0-based: 1 = two levels). Pure helpers are exported for state code and tests.

export interface TreeNode {
  id: string;
  children?: TreeNode[];
}
export interface FlatNode<T extends TreeNode> {
  id: string;
  depth: number;
  parentId: string | null;
  node: T;
}

export function flattenTree<T extends TreeNode>(nodes: T[], depth = 0, parentId: string | null = null): FlatNode<T>[] {
  return nodes.flatMap((node) => [{ id: node.id, depth, parentId, node }, ...flattenTree((node.children ?? []) as T[], depth + 1, node.id)]);
}

/** Rebuilds a tree from a flat list (order + parentId). Children arrays are only set when non-empty. */
export function buildTree<T extends TreeNode>(flat: FlatNode<T>[]): T[] {
  const byId = new Map<string, T>();
  const roots: T[] = [];
  for (const f of flat) {
    const { children: _c, ...rest } = f.node;
    byId.set(f.id, { ...rest } as T);
  }
  for (const f of flat) {
    const node = byId.get(f.id)!;
    const parent = f.parentId ? byId.get(f.parentId) : undefined;
    if (parent) parent.children = [...(parent.children ?? []), node];
    else roots.push(node);
  }
  return roots;
}

function descendantIds<T extends TreeNode>(flat: FlatNode<T>[], id: string): Set<string> {
  const out = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of flat) {
      if (f.parentId && (f.parentId === id || out.has(f.parentId)) && !out.has(f.id)) {
        out.add(f.id);
        changed = true;
      }
    }
  }
  return out;
}

function subtreeHeight<T extends TreeNode>(flat: FlatNode<T>[], id: string): number {
  const base = flat.find((f) => f.id === id)?.depth ?? 0;
  const ids = descendantIds(flat, id);
  return Math.max(0, ...flat.filter((f) => ids.has(f.id)).map((f) => f.depth - base));
}

/**
 * Where `activeId` lands when dropped over `overId` with a horizontal drag of `offsetDepth` levels.
 * Respects `maxDepth` for the dragged node *and* its descendants.
 */
export function getProjection<T extends TreeNode>(
  flat: FlatNode<T>[],
  activeId: string,
  overId: string,
  offsetDepth: number,
  maxDepth: number,
): { depth: number; parentId: string | null } {
  const hidden = descendantIds(flat, activeId);
  const visible = flat.filter((f) => !hidden.has(f.id));
  const activeIndex = visible.findIndex((f) => f.id === activeId);
  const overIndex = visible.findIndex((f) => f.id === overId);
  const active = visible[activeIndex]!;
  const moved = arrayMove(visible, activeIndex, overIndex);
  const prev = moved[overIndex - 1];
  const next = moved[overIndex + 1];
  const height = subtreeHeight(flat, activeId);
  const projected = active.depth + offsetDepth;
  const max = Math.min(prev ? prev.depth + 1 : 0, maxDepth - height);
  const min = next ? next.depth : 0;
  const depth = Math.max(0, Math.min(Math.max(projected, min), max));

  let parentId: string | null = null;
  if (depth > 0 && prev) {
    if (depth === prev.depth) parentId = prev.parentId;
    else if (depth > prev.depth) parentId = prev.id;
    else parentId = moved.slice(0, overIndex).reverse().find((f) => f.depth === depth)?.parentId ?? null;
  }
  return { depth, parentId };
}

/** Applies a projected move and returns the rebuilt tree. */
export function moveTreeNode<T extends TreeNode>(nodes: T[], activeId: string, overId: string, projection: { depth: number; parentId: string | null }): T[] {
  const flat = flattenTree(nodes);
  const activeIndex = flat.findIndex((f) => f.id === activeId);
  const overIndex = flat.findIndex((f) => f.id === overId);
  if (activeIndex < 0 || overIndex < 0) return nodes;
  const hidden = descendantIds(flat, activeId);
  const block = flat.filter((f) => f.id === activeId || hidden.has(f.id));
  const rest = flat.filter((f) => f.id !== activeId && !hidden.has(f.id));
  const delta = projection.depth - flat[activeIndex]!.depth;
  const movedBlock = block.map((f) => (f.id === activeId ? { ...f, depth: projection.depth, parentId: projection.parentId } : { ...f, depth: f.depth + delta }));
  // Insert position = where `over` sits in the list without the dragged block (before/after depending on direction).
  let insertAt = rest.findIndex((f) => f.id === overId);
  if (overId === activeId) insertAt = activeIndex;
  else if (activeIndex < overIndex) {
    // Dragging down: land after `over` and its (visible) descendants that are not nested deeper than the projection.
    insertAt += 1;
  }
  const next = [...rest.slice(0, insertAt), ...movedBlock, ...rest.slice(insertAt)];
  return buildTree(next);
}

export interface SortableTreeProps<T extends TreeNode> {
  items: T[];
  maxDepth: number;
  onChange: (items: T[]) => void;
  renderItem: (flat: FlatNode<T>, state: { handle: SortableHandleProps; isDragging: boolean; depth: number }) => ReactNode;
  indent?: number;
  disabled?: boolean;
  label: string;
  className?: string;
}

function TreeRow<T extends TreeNode>({
  flat,
  depth,
  indent,
  disabled,
  renderItem,
}: {
  flat: FlatNode<T>;
  depth: number;
  indent: number;
  disabled?: boolean;
  renderItem: SortableTreeProps<T>['renderItem'];
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: flat.id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, paddingLeft: depth * indent }}
      className={cn('relative list-none', isDragging && 'z-10 opacity-90')}
    >
      {renderItem(flat, { handle: { ref: setActivatorNodeRef, attributes, listeners }, isDragging, depth })}
    </li>
  );
}

export function SortableTree<T extends TreeNode>({ items, maxDepth, onChange, renderItem, indent = 42, disabled, label, className }: SortableTreeProps<T>) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);

  const flat = useMemo(() => flattenTree(items), [items]);
  const hidden = useMemo(() => (activeId ? descendantIds(flat, activeId) : new Set<string>()), [flat, activeId]);
  const visible = flat.filter((f) => !hidden.has(f.id));
  const projection = activeId && overId ? getProjection(flat, activeId, overId, Math.round(offsetX / indent), maxDepth) : null;

  const reset = () => {
    setActiveId(null);
    setOverId(null);
    setOffsetX(0);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const proj = over ? getProjection(flat, String(active.id), String(over.id), Math.round(offsetX / indent), maxDepth) : null;
    reset();
    if (!over || !proj) return;
    const current = flat.find((f) => f.id === active.id);
    if (active.id === over.id && current?.depth === proj.depth) return;
    onChange(moveTreeNode(items, String(active.id), String(over.id), proj));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={({ active }: DragStartEvent) => {
        setActiveId(String(active.id));
        setOverId(String(active.id));
      }}
      onDragMove={({ delta }: DragMoveEvent) => setOffsetX(delta.x)}
      onDragOver={({ over }) => setOverId(over ? String(over.id) : null)}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      <SortableContext items={visible.map((f) => f.id)} strategy={verticalListSortingStrategy} disabled={disabled}>
        <ul aria-label={label} className={cn('flex flex-col gap-2', className)}>
          {visible.map((f) => (
            <TreeRow
              key={f.id}
              flat={f}
              depth={f.id === activeId && projection ? projection.depth : f.depth}
              indent={indent}
              disabled={disabled}
              renderItem={renderItem}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
