import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { PinitGateway, RegisterGateway } from './pages/auth/PinitGateway';
import { WelcomeHello } from './pages/WelcomeHello';
import { NotFoundPage } from './pages/NotFoundPage';
import { RequireAuth } from './components/auth/RequireAuth';

export const router = createBrowserRouter([
  { path: '/login', element: <PinitGateway /> },
  { path: '/register', element: <RegisterGateway /> },
  {
    path: '/welcome',
    errorElement: <RouteErrorBoundary />,
    element: (
      <RequireAuth>
        <WelcomeHello />
      </RequireAuth>
    ),
  },
  { path: '/', element: <Navigate to="/login" replace /> },
  { path: '*', element: <NotFoundPage /> },
]);
