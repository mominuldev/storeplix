import { Route, Routes } from 'react-router';
import { GuestRoute, ProtectedRoute } from './auth/ProtectedRoute';
import { AppShell } from './layout/AppShell';
import { allRoutes } from './layout/nav';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { MorePage } from './pages/MorePage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { RegisterPage } from './pages/RegisterPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          {allRoutes
            .filter((r) => r.to !== '/')
            .map((r) => (
              <Route key={r.to} path={r.to} element={<PlaceholderPage title={r.label} />} />
            ))}
          <Route path="/help" element={<PlaceholderPage title="Help & support" />} />
          <Route path="/more" element={<MorePage />} />
          <Route path="*" element={<PlaceholderPage title="Page not found" />} />
        </Route>
      </Route>
    </Routes>
  );
}
