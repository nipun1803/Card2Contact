import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "@/layouts/AppLayout";
import { PublicLayout } from "@/layouts/PublicLayout";
import { ProtectedRoute, PublicOnly } from "@/routes/guards";
import { AppSplash } from "@/shared/components/common/AppSplash";
import { ROUTES } from "@/shared/lib/constants";

// Routes are code-split so each page loads on demand.
const Landing = lazy(() => import("@/routes/Landing"));
const Login = lazy(() => import("@/routes/Login"));
const Dashboard = lazy(() => import("@/routes/Dashboard"));
const ScanApp = lazy(() => import("@/routes/ScanApp"));
const Profile = lazy(() => import("@/routes/Profile"));
const NotFound = lazy(() => import("@/routes/NotFound"));

/** Suspense boundary used while a lazy page chunk loads. */
function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<AppSplash message="Loading…" />}>{children}</Suspense>;
}

export const router = createBrowserRouter([
  {
    element: <PublicOnly />,
    children: [
      {
        element: <PublicLayout />,
        children: [
          { path: ROUTES.landing, element: <Lazy><Landing /></Lazy> },
          { path: ROUTES.login, element: <Lazy><Login /></Lazy> },
        ],
      },
    ],
  },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: ROUTES.dashboard, element: <Lazy><Dashboard /></Lazy> },
          { path: ROUTES.scan, element: <Lazy><ScanApp /></Lazy> },
          { path: ROUTES.profile, element: <Lazy><Profile /></Lazy> },
        ],
      },
    ],
  },
  { path: "/404", element: <Lazy><NotFound /></Lazy> },
  { path: "*", element: <Navigate to="/404" replace /> },
]);
