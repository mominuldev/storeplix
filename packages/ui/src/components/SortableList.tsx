import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma V3 editor section list 2045:48343 / dragging state 2054:51605. Drag with the pointer on the grip, or
// focus the grip and use Space → ↑/↓ → Space (dnd-kit keyboard sensor, with screen-reader announcements).
export interface SortableHandleProps {
  ref: (el: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
}

export interface SortableListProps<T extends { id: string }> {
  items: T[];
  onMove: (fromIndex: number, toIndex: number) => void;
  renderItem: (item: T, state: { handle: SortableHandleProps; isDragging: boolean; index: number }) => ReactNode;
  disabled?: boolean;
  className?: string;
  /** Accessible label of the list. */
  label: string;
}

function SortableRow<T extends { id: string }>({
  item,
  index,
  disabled,
  renderItem,
}: {
  item: T;
  index: number;
  disabled?: boolean;
  renderItem: SortableListProps<T>['renderItem'];
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative list-none', isDragging && 'z-10 opacity-90')}
    >
      {renderItem(item, { handle: { ref: setActivatorNodeRef, attributes, listeners }, isDragging, index })}
    </li>
  );
}

export function SortableList<T extends { id: string }>({ items, onMove, renderItem, disabled, className, label }: SortableListProps<T>) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.id === active.id);
    const to = items.findIndex((i) => i.id === over.id);
    if (from >= 0 && to >= 0) onMove(from, to);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy} disabled={disabled}>
        <ul aria-label={label} className={cn('flex flex-col gap-1', className)}>
          {items.map((item, index) => (
            <SortableRow key={item.id} item={item} index={index} disabled={disabled} renderItem={renderItem} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

/** Spread onto the grip button: `<button {...gripProps(handle)}>`. */
export function gripProps(handle: SortableHandleProps) {
  return { ref: handle.ref, ...handle.attributes, ...handle.listeners };
}
