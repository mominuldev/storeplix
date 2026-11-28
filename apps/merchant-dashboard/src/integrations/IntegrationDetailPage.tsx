import { Navigate, useLocation, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { NoAccessState } from '../layout/RequirePermission';
import { FeedPage } from './FeedPage';
import { GtmPage } from './GtmPage';
import { canViewIntegrations, integrationPath, isFeed, isPixel, PROVIDER_BY_SLUG, PROVIDER_META, SLUG_BY_PROVIDER, type PartAProvider } from './integrations';
import { PixelPage } from './PixelPage';

// PHASE-8-9D §8: `/integrations/{meta-pixel|ga4|tiktok|gtm|meta-catalog|google-merchant}`. Readable with
// `integrations.manage | marketing.manage` (P89D-41); staff get the no-access state. The OAuth callback returns to
// `/integrations/{provider}` (snake_case value, §7.1) — those paths redirect to the Figma slug, keeping the query.

export function IntegrationDetailPage({ slug }: { slug: string }) {
  const { activeTenant } = useAuth();
  const provider = PROVIDER_BY_SLUG[slug];
  if (!provider) return <Navigate to="/integrations" replace />;
  if (!canViewIntegrations(activeTenant)) return <NoAccessState heading={PROVIDER_META[provider].name} />;
  if (isPixel(provider)) return <PixelPage key={provider} provider={provider} />;
  if (isFeed(provider)) return <FeedPage key={provider} provider={provider} />;
  return <GtmPage />;
}

/** `/integrations/:provider` for provider values that differ from the slug (`meta_catalog` → `meta-catalog`). */
export function ProviderValueRedirect() {
  const { provider } = useParams();
  const { search } = useLocation();
  const p = provider as PartAProvider | undefined;
  if (p && p in SLUG_BY_PROVIDER) return <Navigate to={`${integrationPath(p)}${search}`} replace />;
  return <Navigate to="/integrations" replace />;
}

export default IntegrationDetailPage;
