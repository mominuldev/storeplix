import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { MobileAppBar, MobileTabBar } from './MobileNav';
import { PlanBanner, PlanLimitDialog, VerifyPhoneBanner } from '../plan/Banners';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

const COLLAPSE_KEY = 'storeplix.merchant.sidebar-collapsed';

/** PHASE-8-8D §11: POS uses the collapsed 72 px sidebar, its own POS bar (no top bar) and the full content area. */
const isPosPath = (pathname: string) => pathname === '/pos' || pathname.startsWith('/pos/');

export function AppShell() {
  const { pathname } = useLocation();
  const pos = isPosPath(pathname);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  // Figma: sidebar toggles with "[".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === '[' && !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) setCollapsed((c) => !c);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex min-h-dvh bg-surface-canvas">
      <Sidebar collapsed={collapsed || pos} />
      <div className="flex min-w-0 flex-1 flex-col">
        {!pos && <Topbar onToggleSidebar={() => setCollapsed((c) => !c)} />}
        <MobileAppBar />
        {/* Figma content 10:781: pt 28, px 32, 20 gaps · mobile 16 side padding; bottom space for tab bar */}
        <main className={pos ? 'flex flex-1 flex-col' : 'flex flex-1 flex-col gap-5 px-4 pt-5 pb-28 lg:px-8 lg:pt-7 lg:pb-10'}>
          <VerifyPhoneBanner />
          <PlanBanner />
          <Outlet />
        </main>
      </div>
      {/* The sale screen has its own sticky Charge bar on phones (P88D-24). */}
      {!/^\/pos\/[^/]+$/.test(pathname) && <MobileTabBar />}
      <PlanLimitDialog />
    </div>
  );
}
