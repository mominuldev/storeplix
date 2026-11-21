import { zodResolver } from "@hookform/resolvers/zod";
import { SESSION_EXPIRED_MESSAGE } from "@storeplix/api-client";
import { Button, Input, SegmentedControl } from "@storeplix/ui";
import { Eye, EyeOff } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { applyApiErrors } from "../auth/formErrors";
import { loginSchema, type LoginValues } from "../auth/schemas";
import { session } from "../lib/session";
import {
  AuthShell,
  FormAlert,
  FormTitle,
  SessionNotice,
} from "../onboarding/AuthShell";
import { SmsLoginForm } from "../otp/SmsLoginForm";

const BANGLA = "আবার স্বাগতম — আজকের অর্ডারগুলো দেখে নিন।";

// Figma Merchant Onboarding · L1 Sign in · Password 57:911 / L2 SMS code 57:1050 / L5 Mobile 58:1132.
// Password sign-in is email + password (contract); the SMS tab signs in with phone + OTP (Addendum A).
// Google sign-in is not in the contract and is omitted.
export function LoginPage() {
  const { login } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [method, setMethod] = useState<"password" | "sms">("password");
  const notice = useSyncExternalStore(
    session.subscribe,
    session.peekNotice,
    () => null
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values);
    } catch (error) {
      setFormError(applyApiErrors(error, setError, ["email", "password"]));
    }
  });

  const createLink = (
    <Link
      to="/register"
      className="text-body font-semibold text-brand-600 hover:text-brand-700"
    >
      Create your shop
    </Link>
  );

  return (
    <AuthShell
      pitch={{
        eyebrow: "Your shop, orders and money — in one place",
        headline: "Welcome back. Your orders are waiting.",
        bangla: BANGLA,
      }}
      topLeft="Welcome back"
      topRight={<>New to Storeplix? {createLink}</>}
      mobile={{ variant: "hero", title: "Welcome back", bangla: BANGLA }}
      mobileFooter={
        <>
          <p className="flex gap-1 text-body text-text-secondary">
            New to Storeplix? {createLink}
          </p>
          <p className="text-caption text-text-muted">
            Help in Bangla · 09678-112233
          </p>
        </>
      }
    >
      <div className="flex flex-col gap-4 lg:gap-7">
        <FormTitle
          className="hidden lg:flex"
          title={
            method === "password"
              ? "Sign in to your shop"
              : "Sign in with a code"
          }
          subtitle={
            method === "password"
              ? "Use the email you signed up with."
              : "Use the mobile number you signed up with."
          }
        />
        {notice === "session_expired" && (
          <SessionNotice>{SESSION_EXPIRED_MESSAGE}</SessionNotice>
        )}
        <SegmentedControl
          aria-label="Sign-in method"
          value={method}
          onChange={setMethod}
          options={[
            { value: "password", label: "Password" },
            { value: "sms", label: "SMS code" },
          ]}
        />
        {method === "sms" ? (
          <SmsLoginForm />
        ) : (
          <form
            onSubmit={onSubmit}
            noValidate
            className="flex flex-col gap-4 lg:gap-7"
          >
            {formError && <FormAlert>{formError}</FormAlert>}
            <div className="flex flex-col gap-4">
              <Input
                label="Email"
                type="email"
                autoComplete="email"
                placeholder="you@shop.com"
                fieldClassName="min-h-12"
                hint="The email you signed up with, or the one your shop owner invited."
                error={errors.email?.message}
                {...register("email")}
              />
              <div className="flex flex-col gap-1.5">
                <Input
                  label="Password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  error={errors.password?.message}
                  trailing={
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </button>
                  }
                  {...register("password")}
                />
                <Link
                  to="/forgot-password"
                  className="self-end text-body font-medium text-brand-600 hover:text-brand-700"
                >
                  Forgot password?
                </Link>
              </div>
            </div>
            <Button
              type="submit"
              fullWidth
              loading={isSubmitting}
              className="min-h-[52px] lg:min-h-12"
            >
              Sign in
            </Button>
            <p className="hidden text-center text-caption text-text-muted lg:block">
              Staff invited to a shop? Sign in with the email your shop owner
              added.
            </p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
