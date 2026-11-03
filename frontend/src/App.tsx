import { Navigate, Route, Routes } from 'react-router-dom';
import RedeemPage from './pages/RedeemPage';
import TaskPage from './pages/TaskPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RedeemPage />} />
      <Route path="/task/:taskId" element={<TaskPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
