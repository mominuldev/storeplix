import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthProvider';
import { GuestRoute, ProtectedRoute } from './auth/ProtectedRoute';
import { AppShell } from './layout/AppShell';
import { allRoutes } from './layout/nav';
import { RequirePermission } from './layout/RequirePermission';
import { can, type PermissionHolder } from './lib/permissions';
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
import { ApiErrorWatcher } from './impersonation/ApiErrorWatcher';
import { ImpersonatePage } from './impersonation/ImpersonatePage';
import { ImpersonationFrame } from './impersonation/ImpersonationFrame';

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
const DeveloperPage = lazy(() => import('./developer/DeveloperPage'));
const CouponsPage = lazy(() => import('./coupons/CouponsPage'));
const CouponEditorPage = lazy(() => import('./coupons/CouponEditorPage'));
// Phase 8.5 marketing campaigns (code-split).
const MarketingOverviewPage = lazy(() => import('./campaigns/MarketingOverviewPage'));
const CampaignsPage = lazy(() => import('./campaigns/CampaignsPage'));
const CampaignComposerPage = lazy(() => import('./campaigns/CampaignComposerPage'));
const CampaignDetailPage = lazy(() => import('./campaigns/CampaignDetailPage'));
// Phase 8.6 automations + checkout recovery (code-split).
const AutomationsPage = lazy(() => import('./automations/AutomationsPage'));
const AutomationEditorPage = lazy(() => import('./automations/AutomationEditorPage'));
const CheckoutRecoveryPage = lazy(() => import('./automations/CheckoutRecoveryPage'));
const AutomationRunsPage = lazy(() => import('./automations/AutomationRunsPage'));
const ShippingPage = lazy(() => import('./settings/ShippingPage'));
const PaymentsSettingsPage = lazy(() => import('./settings/CommerceSettingsPages').then((m) => ({ default: m.PaymentsSettingsPage })));
const NotificationsSettingsPage = lazy(() => import('./settings/CommerceSettingsPages').then((m) => ({ default: m.NotificationsSettingsPage })));
const InvoicesSettingsPage = lazy(() => import('./settings/CommerceSettingsPages').then((m) => ({ default: m.InvoicesSettingsPage })));
const DeliveryPage = lazy(() => import('./onboarding/DeliveryPage'));
const GetPaidPage = lazy(() => import('./onboarding/GetPaidPage'));
const LivePage = lazy(() => import('./onboarding/LivePage'));
// Phase 7 §8.3 reports (code-split).
// Phase 8.3 role editor (code-split).
const RolePage = lazy(() => import('./staff/RolePage'));
const ReportsPage = lazy(() => import('./reports/ReportsPage').then((m) => ({ default: m.ReportsPage })));
// Phase 8.7 expenses (code-split).
const ExpensesPage = lazy(() => import('./expenses/ExpensesPage'));
// Phase 8.8a fake-order guard (code-split).
const FraudGuardPage = lazy(() => import('./fraud/FraudGuardPage'));
const BlockedNumbersPage = lazy(() => import('./fraud/BlockedNumbersPage'));
const DecisionLogPage = lazy(() => import('./fraud/DecisionLogPage'));
// Phase 8.8b suppliers + purchase orders (code-split).
const PurchaseOrdersPage = lazy(() => import('./purchasing/PurchaseOrdersPage'));
const PurchaseOrderFormPage = lazy(() => import('./purchasing/PurchaseOrderFormPage'));
const PurchaseOrderPage = lazy(() => import('./purchasing/PurchaseOrderPage'));
const SuppliersPage = lazy(() => import('./purchasing/SuppliersPage'));
// Phase 8.8c part A: Inventory → Warehouses (code-split).
const WarehousesPage = lazy(() => import('./inventory/warehouses/WarehousesPage'));
// Phase 8.8c part B: Inventory → Transfers + Stock count (code-split).
const TransfersPage = lazy(() => import('./inventory/transfers/TransfersPage'));
const CountsPage = lazy(() => import('./inventory/counts/CountsPage'));
const CountPage = lazy(() => import('./inventory/counts/CountPage'));

const lazyEl = (el: React.ReactNode) => <Suspense fallback={<LoadingState />}>{el}</Suspense>;
/** PHASE-8-3 §7.1: lazy page behind a permission check (no-access state on a deep link). */
const gated = (allow: (m: PermissionHolder) => boolean, el: React.ReactNode) => <RequirePermission allow={allow}>{lazyEl(el)}</RequirePermission>;

/** Routes implemented in Phase 3/4; excluded from the generic placeholders. */
const onlineStoreRoutes = ['/online-store', '/online-store/seo', '/online-store/domains'];
const catalogRoutes = ['/products', '/products/categories', '/products/import', '/inventory', '/customers'];
const reportRoutes = ['/reports'];
const commerceRoutes = ['/orders', '/orders/new', '/orders/print', '/orders/fraud-guard', '/returns', '/shipments', '/marketing', '/marketing/coupons', '/marketing/campaigns', '/marketing/automations', '/integrations'];
const settingsRoutes = ['/settings/store', '/settings/plan', '/settings/shipping', '/settings/payments', '/settings/notifications', '/settings/invoices'];

/** `/marketing`: the overview for `marketing.manage` (PHASE-8-5 §8), Coupons for everyone else. */
function MarketingIndex() {
  const { activeTenant } = useAuth();
  return can.manageMarketing(activeTenant) ? lazyEl(<MarketingOverviewPage />) : <Navigate to="/marketing/coupons" replace />;
}

/** `/reports` → the first allowed tab (PHASE-8-7 P87-16: Sales, else Expenses), keeping the range in the query string. */
function ReportsIndex() {
  const { search } = useLocation();
  const { activeTenant } = useAuth();
  if (!can.viewReports(activeTenant) && can.manageExpenses(activeTenant)) return <Navigate to="/reports/expenses" replace />;
  return <Navigate to={{ pathname: '/reports/sales', search }} replace />;
}

export function AppRoutes() {
  return (
    <>
      <Toaster />
      <ApiErrorWatcher />
      <ImpersonationFrame />
      <Routes>
        <Route element={<GuestRoute />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Route>
        {/* Public: works signed out (new user) and signed in (existing user accepts with the session cookie). */}
        <Route path="/invite" element={<InvitePage />} />
        {/* Phase 8.1: read-only support session from a Store Plix admin ticket (works signed out or in). */}
        <Route path="/impersonate" element={<ImpersonatePage />} />
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
              <Route path="/inventory/purchase-orders" element={gated(can.receiveStock, <PurchaseOrdersPage />)} />
              <Route path="/inventory/purchase-orders/new" element={gated(can.managePurchasing, <PurchaseOrderFormPage />)} />
              <Route path="/inventory/purchase-orders/:id" element={gated(can.receiveStock, <PurchaseOrderPage />)} />
              <Route path="/inventory/purchase-orders/:id/edit" element={gated(can.managePurchasing, <PurchaseOrderFormPage />)} />
              <Route path="/inventory/suppliers" element={gated(can.managePurchasing, <SuppliersPage />)} />
              <Route path="/inventory/warehouses" element={lazyEl(<WarehousesPage />)} />
              <Route path="/inventory/transfers" element={lazyEl(<TransfersPage />)} />
              <Route path="/inventory/transfers/:id" element={lazyEl(<TransfersPage />)} />
              <Route path="/inventory/counts" element={lazyEl(<CountsPage />)} />
              <Route path="/inventory/counts/:id" element={lazyEl(<CountPage />)} />
              <Route path="/customers" element={gated(can.viewCustomers, <CustomersPage />)} />
              <Route path="/customers/:customerId" element={gated(can.viewCustomers, <CustomerDetailPage />)} />
              <Route path="/orders" element={gated(can.seeOrders, <OrdersPage />)} />
              <Route path="/orders/new" element={gated(can.viewOrders, <CreateOrderPage />)} />
              <Route path="/orders/print" element={gated(can.seeShipments, <PrintPage />)} />
              <Route path="/returns/:returnId?" element={gated(can.viewOrders, <ReturnsPage />)} />
              <Route path="/shipments" element={gated(can.seeShipments, <ShipmentsPage />)} />
              <Route path="/shipments/:shipmentId" element={gated(can.seeShipments, <ShipmentDetailPage />)} />
              <Route path="/orders/fraud-guard" element={gated(can.manageFraudGuard, <FraudGuardPage />)} />
              <Route path="/orders/fraud-guard/blocked" element={gated(can.manageFraudGuard, <BlockedNumbersPage />)} />
              <Route path="/orders/fraud-guard/log" element={gated(can.manageFraudGuard, <DecisionLogPage />)} />
              <Route path="/orders/:orderId" element={gated(can.seeOrders, <OrderDetailPage />)} />
              <Route path="/orders/:orderId/edit" element={gated(can.processOrders, <OrderEditPage />)} />
              <Route path="/integrations" element={lazyEl(<IntegrationsPage />)} />
              <Route path="/integrations/developer" element={gated(can.manageDevelopers, <DeveloperPage />)} />
              <Route path="/marketing" element={<MarketingIndex />} />
              <Route path="/marketing/campaigns" element={gated(can.manageMarketing, <CampaignsPage />)} />
              <Route path="/marketing/campaigns/new" element={gated(can.manageMarketing, <CampaignComposerPage />)} />
              <Route path="/marketing/campaigns/:campaignId/edit" element={gated(can.manageMarketing, <CampaignComposerPage />)} />
              <Route path="/marketing/campaigns/:campaignId" element={gated(can.manageMarketing, <CampaignDetailPage />)} />
              <Route path="/marketing/automations" element={gated(can.manageMarketing, <AutomationsPage />)} />
              <Route path="/marketing/automations/runs" element={gated(can.manageMarketing, <AutomationRunsPage />)} />
              <Route path="/marketing/automations/checkout-recovery" element={gated(can.manageMarketing, <CheckoutRecoveryPage />)} />
              <Route path="/marketing/automations/:automationId" element={gated(can.manageMarketing, <AutomationEditorPage />)} />
              <Route path="/marketing/coupons" element={lazyEl(<CouponsPage />)} />
              <Route path="/marketing/coupons/new" element={lazyEl(<CouponEditorPage />)} />
              <Route path="/marketing/coupons/:couponId" element={lazyEl(<CouponEditorPage />)} />
              <Route path="/reports" element={<ReportsIndex />} />
              <Route path="/reports/sales" element={gated(can.viewReports, <ReportsPage type="sales" />)} />
              <Route path="/reports/profit" element={gated(can.viewReports, <ReportsPage type="profit" />)} />
              <Route path="/reports/delivery" element={gated(can.viewReports, <ReportsPage type="delivery" />)} />
              <Route path="/reports/expenses" element={gated(can.manageExpenses, <ExpensesPage />)} />
              <Route path="/staff" element={<StaffPage />} />
              <Route path="/staff/roles/new" element={lazyEl(<RolePage />)} />
              <Route path="/staff/roles/:roleId" element={lazyEl(<RolePage />)} />
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
                .filter((r) => !['/', '/staff', '/settings', ...onlineStoreRoutes, ...catalogRoutes, ...commerceRoutes, ...reportRoutes].includes(r.to))
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
