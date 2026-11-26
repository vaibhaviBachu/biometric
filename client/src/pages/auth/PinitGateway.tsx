import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { LoginFlow } from './LoginFlow';
import { RegistrationFlow } from './RegistrationFlow';

function Booting() {
  return (
    <div className="pinit-auth" style={{ alignItems: 'center', justifyContent: 'center', display: 'flex' }}>
      <div className="pa-spin" style={{ width: 28, height: 28, border: '3px solid rgba(93,137,247,0.2)', borderTopColor: '#0F4FF2', borderRadius: '50%' }} />
    </div>
  );
}

export function PinitGateway() {
  const { loading } = useAuth();
  if (loading) return <Booting />;
  return <LoginFlow />;
}

export function RegisterGateway() {
  const { user, loading } = useAuth();
  if (loading) return <Booting />;

  if (user) {
    return <Navigate to="/welcome" replace />;
  }

  return <RegistrationFlow />;
}
