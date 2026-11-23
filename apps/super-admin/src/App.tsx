import { Card } from '@storeplix/ui';
import { Route, Routes } from 'react-router';
import { RevenuePage } from './analytics/RevenuePage';
import { AuditLogPage } from './audit/AuditLogPage';
import { GuestRoute, ProtectedRoute } from './auth/ProtectedRoute';
import { BillingPage } from './billing/BillingPage';
import { Empty } from './components/States';
import { DomainsPage } from './domains/DomainsPage';
import { ImpersonationsPage } from './impersonations/ImpersonationsPage';
import { AppShell } from './layout/AppShell';
import { PageHeader } from './layout/PageHeader';
import { MerchantDetailPage } from './merchants/MerchantDetailPage';
import { MerchantsPage } from './merchants/MerchantsPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { TeamPage } from './team/TeamPage';

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Card>
        <Empty title="This page doesn’t exist" description="Use the navigation or the search above to find a shop, domain or invoice." />
      </Card>
    </>
  );
}

// Phase 8.1 super admin routes (PHASE-8-1-CONTRACT §7.1). No placeholder pages: unbuilt sections have no route.
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<LoginPage />} />
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="/merchants" element={<MerchantsPage />} />
          <Route path="/merchants/:id" element={<MerchantDetailPage />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/revenue" element={<RevenuePage />} />
          <Route path="/domains" element={<DomainsPage />} />
          <Route path="/impersonations" element={<ImpersonationsPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/audit-log" element={<AuditLogPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
