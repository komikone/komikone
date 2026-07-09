import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import Home from './pages/Home';
import Registration from './pages/Registration';
import JoinPage from './pages/Join';
import LiveBoard from './pages/LiveBoard';
import Payment from './pages/Payment';
import Admin from './pages/Admin';
import Stats from './pages/Stats';
import SignIn from './pages/SignIn';
import DashboardLayout from './dashboard/DashboardLayout';
import DashboardHome from './dashboard/DashboardHome';
import DashboardProfile from './dashboard/DashboardProfile';
import DashboardRegistrations from './dashboard/DashboardRegistrations';
import DashboardBilling from './dashboard/DashboardBilling';
import DashboardInvitations from './dashboard/DashboardInvitations';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  if (!isLoaded) return null;
  if (!isSignedIn) {
    return <Navigate to={`/sign-in?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/register/:eventId" element={<Registration />} />
        <Route path="/join/:code" element={<JoinPage />} />
        <Route path="/dashboard" element={<RequireAuth><DashboardLayout /></RequireAuth>}>
          <Route index element={<DashboardHome />} />
          <Route path="profile" element={<DashboardProfile />} />
          <Route path="registrations" element={<DashboardRegistrations />} />
          <Route path="billing" element={<DashboardBilling />} />
          <Route path="invitations" element={<DashboardInvitations />} />
        </Route>
        <Route path="/profile" element={<Navigate to="/dashboard/billing" replace />} />
        <Route path="/live/:eventId" element={<RequireAuth><LiveBoard /></RequireAuth>} />
        <Route path="/payment/:eventId" element={<RequireAuth><Payment /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><Admin /></RequireAuth>} />
      </Routes>
    </BrowserRouter>
  );
}
