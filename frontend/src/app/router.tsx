import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "@/layouts/AppLayout";
import { PublicLayout } from "@/layouts/PublicLayout";
import { ProtectedRoute, PublicOnly } from "@/routes/guards";
import { AdminProtectedRoute } from "@/routes/admin/guards";
import { AppSplash } from "@/shared/components/common/AppSplash";
import { ROUTES } from "@/shared/lib/constants";

// Routes are code-split so each page loads on demand.
const Landing = lazy(() => import("@/routes/Landing"));
const Login = lazy(() => import("@/routes/Login"));
const Dashboard = lazy(() => import("@/routes/Dashboard"));
const ScanApp = lazy(() => import("@/routes/ScanApp"));
const Profile = lazy(() => import("@/routes/Profile"));
const SessionConflict = lazy(() => import("@/routes/SessionConflict"));
const NotFound = lazy(() => import("@/routes/NotFound"));
const AdminLogin = lazy(() => import("@/routes/admin/AdminLogin"));
const AdminDashboard = lazy(() => import("@/routes/admin/AdminDashboard"));
const AdminUsers = lazy(() => import("@/routes/admin/AdminUsers"));
const AdminUserDetail = lazy(() => import("@/routes/admin/AdminUserDetail"));
const AdminLicenses = lazy(() => import("@/routes/admin/AdminLicenses"));
const AdminLicenseDetail = lazy(() => import("@/routes/admin/AdminLicenseDetail"));
const AdminTiers = lazy(() => import("@/routes/admin/AdminTiers"));
const AdminRequests = lazy(() => import("@/routes/admin/AdminRequests"));
const AdminLicenseSettings = lazy(() => import("@/routes/admin/AdminLicenseSettings"));
const AdminAccount = lazy(() => import("@/routes/admin/AdminAccount"));

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
  /**
   * Deliberately outside BOTH guards. The user arrives here mid-sign-in with a
   * Pending Session and no Active one: PublicOnly would be wrong once they
   * Continue (it bounces authenticated users away), and ProtectedRoute would be
   * wrong before they do (they aren't signed in yet, so it would bounce them to
   * /login and strand the pending session). The page owns its own navigation.
   */
  {
    element: <PublicLayout />,
    children: [
      { path: ROUTES.sessionConflict, element: <Lazy><SessionConflict /></Lazy> },
    ],
  },
  /**
   * Admin — a separate identity system, so deliberately outside BOTH Google
   * guards, and with no AppLayout/PublicLayout chrome.
   *
   * /admin/login must NOT sit under PublicOnly: that guard bounces anyone with a
   * Google session to /dashboard, so an operator who also happens to be signed
   * in as a user could never reach the admin login at all. It must not sit under
   * ProtectedRoute either — an admin need not be a Google user, and would be
   * bounced to /login.
   *
   * /admin/dashboard is gated by AdminProtectedRoute, which reads the Admin
   * Session (useAdminAuth) and never touches useAuth.
   */
  { path: ROUTES.adminLogin, element: <Lazy><AdminLogin /></Lazy> },
  {
    element: <AdminProtectedRoute />,
    children: [
      {
        // AdminDashboard is now a shell (nav + header) wrapping an <Outlet/> —
        // see its own comment. User Directory and User Details nest as
        // children so the nav persists across both pages without duplicating
        // the header in each.
        element: <Lazy><AdminDashboard /></Lazy>,
        children: [
          { index: true, element: <Navigate to={ROUTES.adminUsers} replace /> },
          { path: ROUTES.adminDashboard, element: <Navigate to={ROUTES.adminUsers} replace /> },
          { path: ROUTES.adminUsers, element: <Lazy><AdminUsers /></Lazy> },
          { path: "/admin/users/:googleUserId", element: <Lazy><AdminUserDetail /></Lazy> },
          { path: ROUTES.adminLicenses, element: <Lazy><AdminLicenses /></Lazy> },
          { path: "/admin/licenses/:googleUserId", element: <Lazy><AdminLicenseDetail /></Lazy> },
          { path: ROUTES.adminTiers, element: <Lazy><AdminTiers /></Lazy> },
          { path: ROUTES.adminRequests, element: <Lazy><AdminRequests /></Lazy> },
          { path: ROUTES.adminLicenseSettings, element: <Lazy><AdminLicenseSettings /></Lazy> },
          { path: ROUTES.adminAccount, element: <Lazy><AdminAccount /></Lazy> },
        ],
      },
    ],
  },
  { path: "/404", element: <Lazy><NotFound /></Lazy> },
  { path: "*", element: <Navigate to="/404" replace /> },
]);
