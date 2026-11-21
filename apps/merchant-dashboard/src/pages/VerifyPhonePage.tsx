import { Button, ProgressBar } from '@storeplix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Phone, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { bdMobile, otpCode } from '../auth/schemas';
import { api } from '../lib/api';
import { formatBdPhone } from '../lib/phone';
import { AuthShell, FormAlert } from '../onboarding/AuthShell';
import { OtpCodeField } from '../otp/OtpCodeField';
import { PhoneField } from '../otp/PhoneField';
import { otpErrorMessage, useOtpSender } from '../otp/useOtpSender';

// Figma Merchant Onboarding · 02 Verify phone 46:8705 / M2 53:831. Sends a verify_phone code on arrival,
// verifies via POST /auth/phone/verify. "Wrong number?" lets an unverified user send to a new number.
// "Call me instead" has no API and is omitted. Unverified users can skip (dashboard banner nags).
export function VerifyPhonePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const otp = useOtpSender('verify_phone');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [editing, setEditing] = useState(!user?.phone);
  const [rawPhone, setRawPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const sentOnce = useRef(false);
  const { send } = otp;

  useEffect(() => {
    if (sentOnce.current || !user?.phone || user.phone_verified_at) return;
    sentOnce.current = true;
    void send(user.phone);
  }, [user, send]);

  if (user?.phone_verified_at) return <Navigate to="/" replace />;

  const changeNumber = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = bdMobile.safeParse(rawPhone);
    if (!parsed.success) return setPhoneError(parsed.error.issues[0]!.message);
    setPhoneError(null);
    if (await otp.send(parsed.data)) {
      setPhone(parsed.data);
      setEditing(false);
      setCode('');
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpCode.safeParse(code).success) return setCodeError('Enter the 6-digit code');
    setVerifying(true);
    setCodeError(null);
    try {
      const updated = await api.auth.verifyPhone({ code });
      queryClient.setQueriesData({ queryKey: ['auth', 'me'] }, updated);
      navigate('/', { replace: true });
    } catch (err) {
      setCodeError(otpErrorMessage(err));
    } finally {
      setVerifying(false);
    }
  };

  const skip = (
    <Link to="/" className="text-body font-medium text-brand-600 hover:text-brand-700">
      Skip for now
    </Link>
  );

  return (
    <AuthShell
      pitch={{
        eyebrow: 'Built for Facebook & COD sellers in Bangladesh',
        headline: 'Turn your Facebook page into a real online shop.',
        bangla: '৫ মিনিটে আপনার অনলাইন দোকান চালু করুন — কোনো কোডিং লাগবে না।',
      }}
      topLeft={
        <>
          Step 2 of 7 · Verify phone
          <ProgressBar value={2 / 7} label="Setup progress" className="w-[120px]" />
        </>
      }
      topRight={skip}
      mobile={{ variant: 'plain', action: skip }}
      showTrustRow={false}
    >
      <div className="flex flex-col gap-5 lg:gap-7">
        <Link to="/" className="hidden items-center gap-1 self-start text-body font-medium text-text-secondary lg:flex">
          <ChevronLeft aria-hidden className="size-4" /> Back
        </Link>
        <span className="flex size-[52px] items-center justify-center rounded-[14px] bg-brand-50 text-brand-600 lg:size-14 lg:rounded-card">
          <Phone aria-hidden className="size-6 lg:size-[26px]" />
        </span>
        {editing ? (
          <form onSubmit={changeNumber} noValidate className="flex flex-col gap-4">
            <h1 className="text-heading-24 text-text-primary lg:text-heading-32">Verify your mobile number</h1>
            {otp.error && <FormAlert>{otp.error}</FormAlert>}
            <PhoneField value={rawPhone} onChange={(e) => setRawPhone(e.target.value)} error={phoneError ?? undefined} />
            <Button type="submit" fullWidth loading={otp.sending}>
              Send code
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} noValidate className="flex flex-col gap-5 lg:gap-7">
            <div className="flex flex-col gap-1.5 lg:gap-2">
              <h1 className="text-heading-24 text-text-primary lg:text-heading-32">Enter the 6-digit code</h1>
              <p className="flex flex-wrap gap-1.5 text-body text-text-secondary lg:text-body-lg">
                Sent by SMS to {formatBdPhone(phone)}.
                <button type="button" className="font-semibold text-brand-600 lg:font-medium" onClick={() => setEditing(true)}>
                  Wrong number?
                </button>
              </p>
              <p lang="bn" className="font-bangla text-body-lg leading-[26px] text-text-muted">
                আপনার ফোনে পাঠানো ৬ সংখ্যার কোডটি লিখুন
              </p>
            </div>
            <OtpCodeField
              label="Code"
              value={code}
              onChange={setCode}
              error={codeError ?? otp.error}
              countdown={otp.countdown}
              canResend={otp.canResend}
              onResend={() => void otp.send(phone)}
              devOtp={otp.devOtp}
              boxClassName="h-[58px] lg:h-[68px]"
              autoFocus
            />
            <div className="fixed inset-x-0 bottom-0 border-t border-border-default bg-surface-card px-5 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:static lg:border-0 lg:bg-transparent lg:p-0">
              <Button type="submit" fullWidth loading={verifying}>
                Verify &amp; continue
              </Button>
            </div>
            <p className="mb-24 flex items-start gap-2.5 rounded-lg bg-info-bg p-3.5 text-caption text-text-primary lg:mb-0 lg:text-body">
              <TriangleAlert aria-hidden className="size-[18px] shrink-0 text-info" />
              The SMS comes from “Storeplix”. On some networks it can take up to 30 seconds to arrive.
            </p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
