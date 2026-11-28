import { cn, Logo, NavItem } from '@storeplix/ui';
import { ChevronDown, ChevronRight, LifeBuoy } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { visibleNav, type NavEntry } from './nav';
import { useAuth } from '../auth/AuthProvider';
import { useInboxSummary } from '../inbox/queries';
import { PlanCard } from '../plan/PlanCard';
import { TenantSwitcher } from './TenantSwitcher';

// Figma Merchant Admin – Desktop · Sidebar 10:601 — 256 wide (72 collapsed), surface-card,
// right border, padding 16; logo 32h; store switcher; nav; spacer; Help & support.
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { activeTenant } = useAuth();
  // PHASE-8-8E §12: unread conversations (mine + unassigned), polled every 30 s with `inbox.manage` only.
  const unread = useInboxSummary().data?.unread ?? 0;
  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        'sticky top-[var(--sp-banner-h,0px)] hidden h-[calc(100dvh-var(--sp-banner-h,0px))] shrink-0 flex-col overflow-y-auto border-r border-border-default bg-surface-card p-4 lg:flex',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
      )}
    >
      {/* Figma 10:601: Logo frame 48 (logo 32 + 16) · switcher 52 · 4 spacer · 40px nav rows, no gaps. */}
      <div className={cn('h-12 shrink-0 pl-2', collapsed && 'flex justify-center pl-0')}>
        {collapsed ? <Logo variant="symbol" height={32} /> : <Logo height={32} />}
      </div>
      <TenantSwitcher collapsed={collapsed} />
      <nav className="mt-1 flex flex-col">
        {visibleNav(activeTenant).map((item) => (
          <SidebarEntry key={item.to} item={item} collapsed={collapsed} badge={item.to === '/inbox' && unread > 0 ? unread : undefined} />
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

function SidebarEntry({ item, collapsed, badge }: { item: NavEntry; collapsed: boolean; badge?: number }) {
  const { pathname } = useLocation();
  const inSection = item.to !== '/' && (pathname.startsWith(item.to) || !!item.children?.some((c) => pathname.startsWith(c.to)));
  const [expanded, setExpanded] = useState(inSection);
  const Icon = item.icon;
  const children = item.children;

  if (!item.children || collapsed) {
    return (
      <NavLink to={item.to} end={item.to === '/'} className="rounded-md outline-none focus-visible:shadow-focus" title={collapsed ? item.label : undefined}>
        {({ isActive }) => (
          <NavItem
            icon={<Icon />}
            label={item.label}
            active={isActive || (collapsed && inSection)}
            collapsed={collapsed}
            count={badge !== undefined ? <span aria-label={`${badge} unread`}>{badge > 99 ? '99+' : badge}</span> : undefined}
          />
        )}
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
        <ul className="flex flex-col">
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
