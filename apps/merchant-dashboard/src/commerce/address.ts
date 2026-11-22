import type { AddressInput } from '@storeplix/types';

export type AddressErrors = Partial<Record<'district_code' | 'thana_code' | 'address_line' | 'area' | 'landmark', string>>;

export const emptyAddress: AddressInput = { district_code: '', thana_code: '', address_line: '', area: null, landmark: null, label: null };

export function addressProblems(a: AddressInput): AddressErrors {
  const e: AddressErrors = {};
  if (!a.district_code) e.district_code = 'Choose a district.';
  if (!a.thana_code) e.thana_code = 'Choose a thana or upazila.';
  const line = a.address_line.trim();
  if (line.length < 5) e.address_line = 'Enter the house, road and area (at least 5 characters).';
  else if (line.length > 255) e.address_line = 'Keep the address to 255 characters.';
  return e;
}
