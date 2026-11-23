import { Shield } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';

/** Dialog footer note (45:4989 / 45:8866): shield + "Logged as {name}". */
export function LoggedAs() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <span className="hidden items-center gap-1.5 text-caption text-text-muted sm:flex">
      <Shield aria-hidden className="size-3.5" />
      Logged as {user.name}
    </span>
  );
}
