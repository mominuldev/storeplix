import { lazy, Suspense } from 'react';
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
import { LoadingState } from './online-store/components/Shell';
import { Toaster } from './online-store/components/Toast';
import { PickThemePage } from './pages/PickThemePage';

// Editors are code-split: ajv, Tiptap and dnd-heavy screens load only on these routes (contract §10).
const BrandStylePage = lazy(() => import('./online-store/BrandStylePage').then((m) => ({ default: m.BrandStylePage })));
const NavigationPage = lazy(() => import('./online-store/navigation/NavigationPage').then((m) => ({ default: m.NavigationPage })));
const OverviewPage = lazy(() => import('./online-store/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const PagesPage = lazy(() => import('./online-store/pages/PagesPage').then((m) => ({ default: m.PagesPage })));
const DomainsPage = lazy(() => import('./online-store/domains/DomainsPage'));
const SeoPage = lazy(() => import('./online-store/SeoPage').then((m) => ({ default: m.SeoPage })));
const ThemesPage = lazy(() => import('./online-store/ThemesPage').then((m) => ({ default: m.ThemesPage })));
const ThemeEditorPage = lazy(() => import('./online-store/editor/ThemeEditorPage'));
const PageEditorPage = lazy(() => import('./online-store/pages/PageEditorPage'));
// Phase 4 catalog screens (code-split; the editor pulls Tiptap + dnd-kit).
const ProductsPage = lazy(() => import('./products/ProductsPage').then((m) => ({ default: m.ProductsPage })));
const ProductEditorPage = lazy(() => import('./products/ProductEditorPage'));
const CategoriesPage = lazy(() => import('./products/CategoriesPage'));
const ImportPage = lazy(() => import('./imports/ImportPage'));
const InventoryPage = lazy(() => import('./inventory/InventoryPage'));
const CustomersPage = lazy(() => import('./customers/CustomersPage'));
const CustomerDetailPage = lazy(() => import('./customers/CustomerDetailPage'));
const AddProductsPage = lazy(() => import('./onboarding/AddProductsPage'));
// Phase 5a commerce screens.
const OrdersPage = lazy(() => import('./orders/OrdersPage'));
const OrderDetailPage = lazy(() => import('./orders/OrderDetailPage'));
const OrderEditPage = lazy(() => import('./orders/OrderEditPage'));
const CreateOrderPage = lazy(() => import('./orders/CreateOrderPage'));
const ReturnsPage = lazy(() => import('./returns/ReturnsPage'));
const ShipmentsPage = lazy(() => import('./shipments/ShipmentsPage'));
const ShipmentDetailPage = lazy(() => import('./shipments/ShipmentDetailPage'));
const PrintPage = lazy(() => import('./documents/PrintPage'));
const IntegrationsPage = lazy(() => import('./integrations/IntegrationsPage'));
const CouponsPage = lazy(() => import('./coupons/CouponsPage'));
const CouponEditorPage = lazy(() => import('./coupons/CouponEditorPage'));
const ShippingPage = lazy(() => import('./settings/ShippingPage'));
const PaymentsSettingsPage = lazy(() => import('./settings/CommerceSettingsPages').then((m) => ({ default: m.PaymentsSettingsPage })));
const NotificationsSettingsPage = lazy(() => import('./settings/CommerceSettingsPages').then((m) => ({ default: m.NotificationsSettingsPage })));
const InvoicesSettingsPage = lazy(() => import('./settings/CommerceSettingsPages').then((m) => ({ default: m.InvoicesSettingsPage })));
const DeliveryPage = lazy(() => import('./onboarding/DeliveryPage'));
const GetPaidPage = lazy(() => import('./onboarding/GetPaidPage'));
const LivePage = lazy(() => import('./onboarding/LivePage'));

const lazyEl = (el: React.ReactNode) => <Suspense fallback={<LoadingState />}>{el}</Suspense>;

/** Routes implemented in Phase 3/4; excluded from the generic placeholders. */
const onlineStoreRoutes = ['/online-store', '/online-store/seo', '/online-store/domains'];
const catalogRoutes = ['/products', '/products/categories', '/products/import', '/inventory', '/customers'];
const commerceRoutes = ['/orders', '/orders/new', '/orders/print', '/returns', '/shipments', '/marketing', '/marketing/coupons', '/integrations'];
const settingsRoutes = ['/settings/store', '/settings/plan', '/settings/shipping', '/settings/payments', '/settings/notifications', '/settings/invoices'];

export function AppRoutes() {
  return (
    <>
      <Toaster />
      <Routes>
        <Route element={<GuestRoute />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Route>
        {/* Public: works signed out (new user) and signed in (existing user accepts with the session cookie). */}
        <Route path="/invite" element={<InvitePage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/choose-shop" element={<ChooseShopPage />} />
          <Route path="/onboarding/shop" element={<NameShopPage />} />
          <Route path="/verify-phone" element={<VerifyPhonePage />} />
          <Route element={<StoreGate />}>
            <Route path="/onboarding/theme" element={<PickThemePage />} />
            <Route path="/onboarding/products" element={lazyEl(<AddProductsPage />)} />
            <Route path="/onboarding/delivery" element={lazyEl(<DeliveryPage />)} />
            <Route path="/onboarding/payments" element={lazyEl(<GetPaidPage />)} />
            <Route path="/onboarding/live" element={lazyEl(<LivePage />)} />
            {/* Full-screen editors (outside AppShell) */}
            <Route
              path="/online-store/editor"
              element={
                <Suspense fallback={<LoadingState label="Opening the editor" />}>
                  <ThemeEditorPage />
                </Suspense>
              }
            />
            <Route
              path="/online-store/pages/:pageId"
              element={
                <Suspense fallback={<LoadingState label="Opening the page" />}>
                  <PageEditorPage />
                </Suspense>
              }
            />
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />
              <Route
                path="/online-store"
                element={
                  <Suspense fallback={<LoadingState />}>
                    <OverviewPage />
                  </Suspense>
                }
              />
              <Route
                path="/online-store/themes"
                element={
                  <Suspense fallback={<LoadingState />}>
                    <ThemesPage />
                  </Suspense>
                }
              />
              <Route
                path="/online-store/brand-style"
                element={
                  <Suspense fallback={<LoadingState />}>
                    <BrandStylePage />
                  </Suspense>
                }
              />
              <Route
                path="/online-store/pages"
                element={
                  <Suspense fallback={<LoadingState />}>
                    <PagesPage />
                  </Suspense>
                }
              />
              <Route
                path="/online-store/navigation"
                element={
                  <Suspense fallback={<LoadingState />}>
                    <NavigationPage />
                  </Suspense>
                }
              />
              <Route path="/online-store/domains" element={lazyEl(<DomainsPage />)} />
              <Route path="/online-store/domains/:domainId" element={lazyEl(<DomainsPage />)} />
              <Route
                path="/online-store/seo"
                element={
                  <Suspense fallback={<LoadingState />}>
                    <SeoPage />
                  </Suspense>
                }
              />
              <Route path="/products" element={lazyEl(<ProductsPage />)} />
              <Route path="/products/new" element={lazyEl(<ProductEditorPage />)} />
              <Route path="/products/categories" element={lazyEl(<CategoriesPage />)} />
              <Route path="/products/import" element={lazyEl(<ImportPage />)} />
              <Route path="/products/:productId" element={lazyEl(<ProductEditorPage />)} />
              <Route path="/inventory" element={lazyEl(<InventoryPage />)} />
              <Route path="/customers" element={lazyEl(<CustomersPage />)} />
              <Route path="/customers/:customerId" element={lazyEl(<CustomerDetailPage />)} />
              <Route path="/orders" element={lazyEl(<OrdersPage />)} />
              <Route path="/orders/new" element={lazyEl(<CreateOrderPage />)} />
              <Route path="/orders/print" element={lazyEl(<PrintPage />)} />
              <Route path="/returns/:returnId?" element={lazyEl(<ReturnsPage />)} />
              <Route path="/shipments" element={lazyEl(<ShipmentsPage />)} />
              <Route path="/shipments/:shipmentId" element={lazyEl(<ShipmentDetailPage />)} />
              <Route path="/orders/:orderId" element={lazyEl(<OrderDetailPage />)} />
              <Route path="/orders/:orderId/edit" element={lazyEl(<OrderEditPage />)} />
              <Route path="/integrations" element={lazyEl(<IntegrationsPage />)} />
              <Route path="/marketing" element={<Navigate to="/marketing/coupons" replace />} />
              <Route path="/marketing/coupons" element={lazyEl(<CouponsPage />)} />
              <Route path="/marketing/coupons/new" element={lazyEl(<CouponEditorPage />)} />
              <Route path="/marketing/coupons/:couponId" element={lazyEl(<CouponEditorPage />)} />
              <Route path="/staff" element={<StaffPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/settings" element={<SettingsLayout />}>
                <Route index element={<Navigate to="store" replace />} />
                <Route path="store" element={<StoreDetailsPage />} />
                <Route path="plan" element={<PlanPage />} />
                <Route path="shipping" element={lazyEl(<ShippingPage />)} />
                <Route path="payments" element={lazyEl(<PaymentsSettingsPage />)} />
                <Route path="notifications" element={lazyEl(<NotificationsSettingsPage />)} />
                <Route path="invoices" element={lazyEl(<InvoicesSettingsPage />)} />
                {settingsNav
                  .flatMap((g) => g.items)
                  .filter((i) => !i.external && !settingsRoutes.includes(i.to))
                  .map((i) => (
                    <Route key={i.to} path={i.to.replace('/settings/', '')} element={<SettingsComingSoon title={i.label} />} />
                  ))}
              </Route>
              {allRoutes
                .filter((r) => !['/', '/staff', '/settings', ...onlineStoreRoutes, ...catalogRoutes, ...commerceRoutes].includes(r.to))
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
    </>
  );
}
