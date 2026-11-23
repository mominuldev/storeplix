import { useState } from 'react';

/** Cursor pagination (audit logs): a stack of cursors so "Previous" works without `prev_cursor` round-trips. */
export function useCursorPages(resetKey: string) {
  const [state, setState] = useState<{
    key: string;
    stack: (string | undefined)[];
  }>({ key: resetKey, stack: [undefined] });
  const stack = state.key === resetKey ? state.stack : [undefined];
  return {
    cursor: stack[stack.length - 1],
    page: stack.length,
    next: (cursor: string) => setState({ key: resetKey, stack: [...stack, cursor] }),
    prev: () =>
      setState({
        key: resetKey,
        stack: stack.length > 1 ? stack.slice(0, -1) : stack,
      }),
  };
}
