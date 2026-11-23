import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { MobileAppBar, MobileTabBar } from './MobileNav';
import { PlanBanner, PlanLimitDialog, VerifyPhoneBanner } from '../plan/Banners';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

const COLLAPSE_KEY = 'storeplix.merchant.sidebar-collapsed';

export function AppShell() {
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
      <Sidebar collapsed={collapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onToggleSidebar={() => setCollapsed((c) => !c)} />
        <MobileAppBar />
        {/* Figma content 10:781: pt 28, px 32, 20 gaps · mobile 16 side padding; bottom space for tab bar */}
        <main className="flex flex-1 flex-col gap-5 px-4 pt-5 pb-28 lg:px-8 lg:pt-7 lg:pb-10">
          <VerifyPhoneBanner />
          <PlanBanner />
          <Outlet />
        </main>
      </div>
      <MobileTabBar />
      <PlanLimitDialog />
    </div>
  );
}
