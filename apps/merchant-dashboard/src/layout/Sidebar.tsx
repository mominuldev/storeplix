import { cn, Logo, NavItem } from '@storeplix/ui';
import { ChevronDown, ChevronRight, LifeBuoy } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { mainNav, type NavEntry } from './nav';
import { useStoreScope } from '../catalog/scope';
import { PlanCard } from '../plan/PlanCard';
import { TenantSwitcher } from './TenantSwitcher';

// Figma Merchant Admin – Desktop · Sidebar 10:601 — 256 wide (72 collapsed), surface-card,
// right border, padding 16; logo 32h; store switcher; nav; spacer; Help & support.
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        'sticky top-0 hidden h-dvh shrink-0 flex-col gap-4 overflow-y-auto border-r border-border-default bg-surface-card p-4 lg:flex',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
      )}
    >
      <div className={cn('pl-2', collapsed && 'flex justify-center pl-0')}>
        {collapsed ? <Logo variant="symbol" height={32} /> : <Logo height={32} />}
      </div>
      <TenantSwitcher collapsed={collapsed} />
      <nav className="flex flex-col gap-0.5">
        {mainNav.map((item) => (
          <SidebarEntry key={item.to} item={item} collapsed={collapsed} />
        ))}
      </nav>
      <div className="flex-1" />
      <NavLink to="/help" className="rounded-md outline-none focus-visible:shadow-focus" title={collapsed ? 'Help & support' : undefined}>
        {({ isActive }) => <NavItem icon={<LifeBuoy />} label="Help & support" active={isActive} collapsed={collapsed} />}
      </NavLink>
      <PlanCard collapsed={collapsed} />
    </aside>
  );
}

function SidebarEntry({ item, collapsed }: { item: NavEntry; collapsed: boolean }) {
  const { pathname } = useLocation();
  const inSection = item.to !== '/' && (pathname.startsWith(item.to) || !!item.children?.some((c) => pathname.startsWith(c.to)));
  const [expanded, setExpanded] = useState(inSection);
  const { canBulkData } = useStoreScope();
  const Icon = item.icon;
  const children = item.children?.filter((c) => c.requires !== 'bulkData' || canBulkData);

  if (!item.children || collapsed) {
    return (
      <NavLink to={item.to} end={item.to === '/'} className="rounded-md outline-none focus-visible:shadow-focus" title={collapsed ? item.label : undefined}>
        {({ isActive }) => <NavItem icon={<Icon />} label={item.label} active={isActive || (collapsed && inSection)} collapsed={collapsed} />}
      </NavLink>
    );
  }

  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className="block w-full rounded-md text-left outline-none focus-visible:shadow-focus"
      >
        <NavItem icon={<Icon />} label={item.label} count={<Chevron className="!size-4" aria-hidden />} className="[&>span:last-child]:bg-transparent [&>span:last-child]:px-0" />
      </button>
      {expanded && (
        <ul className="mt-0.5 flex flex-col gap-0.5">
          {children!.map((child) => (
            <li key={child.to}>
              {/* Figma SubNavItem 8:264 — h 32, pl 40, pr 12, radius 8 */}
              <NavLink
                to={child.to}
                end
                className={({ isActive }) =>
                  cn(
                    'flex h-8 items-center rounded-md pr-3 pl-10 text-body outline-none focus-visible:shadow-focus',
                    isActive ? 'bg-brand-50 font-semibold text-brand-700' : 'text-text-secondary hover:bg-surface-subtle',
                  )
                }
              >
                {child.label}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
