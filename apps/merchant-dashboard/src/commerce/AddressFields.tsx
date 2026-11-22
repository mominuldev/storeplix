import type { AddressInput } from '@storeplix/types';
import { Input, Select } from '@storeplix/ui';
import type { AddressErrors } from './address';
import { useGeoIndex } from './queries';

// Delivery address block shared by Create order 39:14382, the order address dialog (P5-20) and pickup addresses:
// District → Thana / area selects from `GET /geo/bd`, address line, optional area and landmark.

export function AddressFields({
  value,
  onChange,
  errors = {},
  extra = true,
  idPrefix = 'addr',
  disabled,
}: {
  value: AddressInput;
  onChange: (next: AddressInput) => void;
  errors?: AddressErrors;
  /** Show the optional Area and Landmark fields. */
  extra?: boolean;
  idPrefix?: string;
  disabled?: boolean;
}) {
  const geo = useGeoIndex();
  const district = geo.index.districts.find((d) => d.code === value.district_code);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Select
        id={`${idPrefix}-district`}
        label="District"
        value={value.district_code}
        disabled={disabled || geo.isPending}
        error={errors.district_code ?? (geo.isError ? 'We couldn’t load districts. Reload the page.' : undefined)}
        onChange={(e) => onChange({ ...value, district_code: e.target.value, thana_code: '' })}
      >
        <option value="">{geo.isPending ? 'Loading…' : 'Choose district'}</option>
        {geo.index.districts.map((d) => (
          <option key={d.code} value={d.code}>
            {d.name}
          </option>
        ))}
      </Select>
      <Select
        id={`${idPrefix}-thana`}
        label="Thana / Upazila"
        value={value.thana_code}
        disabled={disabled || !district}
        error={errors.thana_code}
        onChange={(e) => onChange({ ...value, thana_code: e.target.value })}
      >
        <option value="">{district ? 'Choose thana' : 'Choose a district first'}</option>
        {district?.thanas.map((t) => (
          <option key={t.code} value={t.code}>
            {t.name}
          </option>
        ))}
      </Select>
      <Input
        id={`${idPrefix}-line`}
        label="Full address"
        placeholder="House 12, Road 7, Block C"
        value={value.address_line}
        maxLength={255}
        disabled={disabled}
        error={errors.address_line}
        containerClassName="sm:col-span-2"
        onChange={(e) => onChange({ ...value, address_line: e.target.value })}
      />
      {extra && (
        <>
          <Input
            id={`${idPrefix}-area`}
            label="Area (optional)"
            value={value.area ?? ''}
            maxLength={120}
            disabled={disabled}
            error={errors.area}
            onChange={(e) => onChange({ ...value, area: e.target.value || null })}
          />
          <Input
            id={`${idPrefix}-landmark`}
            label="Landmark (optional)"
            value={value.landmark ?? ''}
            maxLength={160}
            disabled={disabled}
            error={errors.landmark}
            onChange={(e) => onChange({ ...value, landmark: e.target.value || null })}
          />
        </>
      )}
    </div>
  );
}
