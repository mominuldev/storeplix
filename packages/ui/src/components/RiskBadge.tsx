import { Badge, type BadgeTone } from './Badge';

// Figma Components · RiskBadge 3:57 — Pill with a 6px dot: Good (success), Be careful (warning), Risky (danger),
// New buyer (neutral). PHASE-8-8 §3.3: one own-shop tier everywhere (orders, customers, guard page).
export type RiskTierValue = 'good' | 'careful' | 'risky' | 'new';

export const riskTierMeta: Record<RiskTierValue, { label: string; tone: BadgeTone }> = {
  good: { label: 'Good', tone: 'success' },
  careful: { label: 'Be careful', tone: 'warning' },
  risky: { label: 'Risky', tone: 'danger' },
  new: { label: 'New buyer', tone: 'neutral' },
};

export function RiskBadge({ tier, size = 'md', className }: { tier: RiskTierValue; size?: 'md' | 'sm'; className?: string }) {
  const meta = riskTierMeta[tier];
  return (
    <Badge tone={meta.tone} dot size={size} className={className}>
      {meta.label}
    </Badge>
  );
}
