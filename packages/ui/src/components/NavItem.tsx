import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma Components · NavItem 3:80 — h 40, px 12, py 8, gap 10, radius md, 18px icon.
// default: Body/14 Medium text-secondary, count surface-subtle · active: brand-50 bg, Semibold brand-700, count brand-600.
// Presentational: wrap in a router link, e.g. <NavLink>{({ isActive }) => <NavItem active={isActive} … />}</NavLink>.
export interface NavItemProps {
  icon?: ReactNode;
  label: ReactNode;
  count?: ReactNode;
  active?: boolean;
  collapsed?: boolean;
  className?: string;
}

export function NavItem({ icon, label, count, active = false, collapsed = false, className }: NavItemProps) {
  return (
    <span
      className={cn(
        'flex h-10 items-center gap-2.5 rounded-md px-3 py-2 text-body transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0',
        active
          ? 'bg-brand-50 font-semibold text-brand-700'
          : 'font-medium text-text-secondary hover:bg-surface-subtle hover:text-text-primary',
        collapsed && 'justify-center px-0',
        className,
      )}
    >
      {icon}
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && count !== undefined && (
        <span
          className={cn(
            'rounded-full px-2 py-px text-caption font-medium',
            active ? 'bg-brand-600 text-text-inverse' : 'bg-surface-subtle text-text-secondary',
          )}
        >
          {count}
        </span>
      )}
    </span>
  );
}
