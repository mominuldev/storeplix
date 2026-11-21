/** BD mobile per Addendum A: accepts 01XXXXXXXXX, 8801XXXXXXXXX, +8801XXXXXXXXX (spaces/dashes ignored). */
const BD = /^(?:\+?88)?(01[3-9]\d{8})$/;

export function normalizeBdPhone(input: string): string | null {
  const m = BD.exec(input.replace(/[\s-]/g, ''));
  return m ? `88${m[1]}` : null;
}

/** 8801712345678 → 01712-345678 (Figma display style). */
export function formatBdPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const n = normalizeBdPhone(phone);
  if (!n) return phone;
  const local = n.slice(2);
  return `${local.slice(0, 5)}-${local.slice(5)}`;
}
