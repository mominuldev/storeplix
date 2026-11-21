import { Navigate, Route, Routes } from 'react-router';
import { GuestRoute, ProtectedRoute } from './auth/ProtectedRoute';
import { AppShell } from './layout/AppShell';
import { allRoutes } from './layout/nav';
import { ChooseShopPage } from './pages/ChooseShopPage';
import { DashboardPage } from './pages/DashboardPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LoginPage } from './pages/LoginPage';
import { MorePage } from './pages/MorePage';
import { NameShopPage } from './pages/NameShopPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { RegisterPage } from './pages/RegisterPage';
import { StoreGate } from './stores/StoreGate';
import { AccountPage } from './pages/AccountPage';
import { InvitePage } from './pages/InvitePage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { StaffPage } from './pages/StaffPage';
import { VerifyPhonePage } from './pages/VerifyPhonePage';
import { PlanPage } from './settings/PlanPage';
import { SettingsComingSoon, SettingsLayout, settingsNav } from './settings/SettingsLayout';
import { StoreDetailsPage } from './settings/StoreDetailsPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Route>
      {/* Public: works signed out (new user) and signed in (existing user accepts with Bearer). */}
      <Route path="/invite" element={<InvitePage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/choose-shop" element={<ChooseShopPage />} />
        <Route path="/onboarding/shop" element={<NameShopPage />} />
        <Route path="/verify-phone" element={<VerifyPhonePage />} />
        <Route element={<StoreGate />}>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="store" replace />} />
              <Route path="store" element={<StoreDetailsPage />} />
              <Route path="plan" element={<PlanPage />} />
              {settingsNav
                .flatMap((g) => g.items)
                .filter((i) => !i.external && !['/settings/store', '/settings/plan'].includes(i.to))
                .map((i) => (
                  <Route key={i.to} path={i.to.replace('/settings/', '')} element={<SettingsComingSoon title={i.label} />} />
                ))}
            </Route>
            {allRoutes
              .filter((r) => !['/', '/staff', '/settings'].includes(r.to))
              .map((r) => (
                <Route key={r.to} path={r.to} element={<PlaceholderPage title={r.label} />} />
              ))}
            <Route path="/help" element={<PlaceholderPage title="Help & support" />} />
            <Route path="/more" element={<MorePage />} />
            <Route path="*" element={<PlaceholderPage title="Page not found" />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}
