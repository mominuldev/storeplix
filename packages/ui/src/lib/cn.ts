import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge about the custom token utilities so they merge correctly.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'heading', 'heading-32', 'heading-24', 'body-lg', 'body', 'caption'] }],
      shadow: [{ shadow: ['elevation-1', 'focus', 'dialog'] }],
      rounded: [{ rounded: ['card', 'control', 'dialog'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
