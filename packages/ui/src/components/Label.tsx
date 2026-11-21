import type { LabelHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

// Figma: Input 3:58 label — Body/14 Medium, text-primary.
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-body font-medium text-text-primary', className)} {...props} />;
}
