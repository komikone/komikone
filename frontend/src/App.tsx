import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Registration from './pages/Registration';
import LiveBoard from './pages/LiveBoard';
import Payment from './pages/Payment';
import Admin from './pages/Admin';
import Stats from './pages/Stats';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/register/:eventId" element={<Registration />} />
        <Route path="/live/:eventId" element={<LiveBoard />} />
        <Route path="/payment/:eventId" element={<Payment />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/stats" element={<Stats />} />
      </Routes>
    </BrowserRouter>
  );
}
