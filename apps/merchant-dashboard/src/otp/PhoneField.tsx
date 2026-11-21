import { Input, type InputProps } from '@storeplix/ui';
import { images } from '../onboarding/assets';

// Figma L1/L2/01 phone field: 48h, BD flag + "+88" prefix, 1×24 divider.
export function PhoneField(props: Omit<InputProps, 'leading' | 'type'>) {
  return (
    <Input
      label="Mobile number"
      type="tel"
      inputMode="tel"
      autoComplete="tel-national"
      placeholder="01712-345678"
      fieldClassName="min-h-12"
      className="text-body-lg"
      leading={
        <>
          <img src={images.flagBd} alt="" width={20} height={14} />
          +88
        </>
      }
      {...props}
    />
  );
}
