import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import Home from './pages/Home';
import Registration from './pages/Registration';
import LiveBoard from './pages/LiveBoard';
import Payment from './pages/Payment';
import Admin from './pages/Admin';
import Stats from './pages/Stats';
import SignIn from './pages/SignIn';

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
        <Route path="/live/:eventId" element={<RequireAuth><LiveBoard /></RequireAuth>} />
        <Route path="/payment/:eventId" element={<RequireAuth><Payment /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><Admin /></RequireAuth>} />
      </Routes>
    </BrowserRouter>
  );
}
