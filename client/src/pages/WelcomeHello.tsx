import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, LogOut } from 'lucide-react';

import { AuthShell } from '../components/auth/AuthShell';
import { StepHead } from '../components/auth/parts';
import { useAuth } from '../context/AuthContext';

/**
 * Minimal post-authentication destination for the standalone face-only signup/sign-in feature.
 * Deliberately independent of DashboardLayout (the full Hub shell) and of `/home` — it must still
 * work once this feature is extracted and deployed on its own. The identity shown here always
 * comes from AuthContext's `user` (set by `loginWithFaceResponse` on both signup and sign-in), never
 * from a signup-only local variable, so a later face sign-in shows the correct matched account.
 */
export function WelcomeHello() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <AuthShell steps={0} current={0} tagline="Signed in">
      <div className="pa-card" style={{ textAlign: 'center' }}>
        <StepHead
          icon={<CheckCircle2 size={26} color="#0F4FF2" />}
          title="Hello, welcome!"
          subtitle={user?.shortId ? <>You&apos;re signed in as <b>{user.shortId}</b>.</> : 'You are signed in.'}
        />
        <button
          type="button"
          className="pa-btn pa-btn-ghost"
          onClick={handleSignOut}
          disabled={signingOut}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <LogOut size={16} />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </AuthShell>
  );
}
