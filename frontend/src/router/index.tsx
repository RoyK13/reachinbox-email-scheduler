import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { FullPageSpinner } from '../components/ui/States';
import { LoginPage } from '../pages/LoginPage';
import { ScheduledPage } from '../pages/ScheduledPage';
import { SentPage } from '../pages/SentPage';
import { ProtectedRoute, PublicOnlyRoute } from './ProtectedRoute';

// Heavier screens (rich-text editor, HTML sanitizer) are code-split.
const ComposePage = lazy(() => import('../pages/ComposePage').then((m) => ({ default: m.ComposePage })));
const EmailDetailPage = lazy(() => import('../pages/EmailDetailPage').then((m) => ({ default: m.EmailDetailPage })));

const suspense = (node: ReactNode) => <Suspense fallback={<FullPageSpinner />}>{node}</Suspense>;

export const router = createBrowserRouter([
  {
    path: '/login',
    element: (
      <PublicOnlyRoute>
        <LoginPage />
      </PublicOnlyRoute>
    ),
  },
  {
    element: <ProtectedRoute />,
    children: [
      { index: true, element: <Navigate to="/scheduled" replace /> },
      { path: 'scheduled', element: <ScheduledPage /> },
      { path: 'sent', element: <SentPage /> },
      { path: 'emails/:id', element: suspense(<EmailDetailPage />) },
      { path: 'compose', element: suspense(<ComposePage />) },
    ],
  },
  { path: '*', element: <Navigate to="/scheduled" replace /> },
]);
