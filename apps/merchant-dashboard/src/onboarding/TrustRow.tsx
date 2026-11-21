import { partners } from './assets';

// Figma 01/L1 trust row: caption muted + pills (surface-card, border-default, radius full, pl 6 pr 12 py 6, 24px logo).
// bKash is a text badge (#e2136e, raw brand colour of the partner) in Figma, not an image.
export function TrustRow() {
  return (
    <div className="hidden flex-col items-center gap-3 lg:flex">
      <p className="text-caption text-text-muted">Works with the couriers &amp; payment gateways you already use</p>
      <ul className="flex flex-wrap justify-center gap-2">
        {partners.map((p) => (
          <li
            key={p.name}
            className={
              p.logo
                ? 'flex items-center gap-2 rounded-full border border-border-default bg-surface-card py-1.5 pr-3 pl-1.5'
                : 'flex items-center rounded-full border border-border-default bg-surface-card p-1.5'
            }
          >
            {p.logo ? (
              <>
                <img src={p.logo} alt="" width={24} height={24} className="size-6 rounded-sm object-contain" />
                <span className="text-caption font-medium text-text-secondary">{p.name}</span>
              </>
            ) : (
              <span className="rounded-sm bg-[#e2136e] px-2 py-[3px] text-caption font-medium text-text-inverse">{p.name}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Figma M1 53:758 mobile trust tiles: 44×44, border, radius 10, 30px logos.
export function TrustTiles() {
  return (
    <div className="flex flex-col gap-2.5 pt-2 lg:hidden">
      <p className="text-caption text-text-muted">Works with your courier &amp; gateway</p>
      <ul className="flex flex-wrap gap-2.5">
        {partners.map((p) =>
          p.logo ? (
            <li key={p.name} className="flex size-11 items-center justify-center rounded-control border border-border-default bg-surface-card">
              <img src={p.logo} alt={p.name} width={30} height={30} className="size-[30px] rounded-sm object-contain" />
            </li>
          ) : (
            <li key={p.name} className="flex size-11 items-center justify-center rounded-control bg-[#e2136e] text-[10px] font-medium text-text-inverse">
              {p.name}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
