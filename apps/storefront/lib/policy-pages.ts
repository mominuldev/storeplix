/**
 * Published policy pages worth linking from the PDP and cart ("Delivery & returns"). Matched by slug
 * (the Phase 3 defaults are `delivery-return`, `privacy`, `terms`); nothing is claimed without a page.
 */
export function policyLinks(pages: Array<{ slug: string }>): Array<{ label: string; href: string }> {
  const out: Array<{ label: string; href: string }> = [];
  const delivery = pages.find((p) => /deliver|shipping/.test(p.slug));
  const returns = pages.find((p) => p !== delivery && /return|refund|exchange/.test(p.slug));
  if (delivery) out.push({ label: /return/.test(delivery.slug) ? 'Delivery & return policy' : 'Delivery policy', href: `/pages/${delivery.slug}` });
  if (returns) out.push({ label: 'Return policy', href: `/pages/${returns.slug}` });
  return out;
}

/** True when the store has published a returns policy (only then may "easy returns" copy appear). */
export function hasReturnPolicy(pages: Array<{ slug: string }>): boolean {
  return pages.some((p) => /return|refund|exchange/.test(p.slug));
}
