import { Route, Routes } from 'react-router';
import { GuestRoute, ProtectedRoute } from './auth/ProtectedRoute';
import { AppShell } from './layout/AppShell';
import { allNav } from './layout/nav';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { PlaceholderPage } from './pages/PlaceholderPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<LoginPage />} />
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          {allNav
            .filter((n) => n.to !== '/')
            .map((n) => (
              <Route key={n.to} path={n.to} element={<PlaceholderPage title={n.label} />} />
            ))}
          <Route path="*" element={<PlaceholderPage title="Page not found" />} />
        </Route>
      </Route>
    </Routes>
  );
}
