import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useAdminAuthActions } from "@/features/admin/useAdminAuth";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/shared/components/ui/form";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { ApiError, NetworkError } from "@/shared/services/api";
import { ROUTES } from "@/shared/lib/constants";

/**
 * Operator login. Deliberately plain: no marketing copy, no Google button, no
 * product chrome — this is not a customer surface.
 *
 * See docs/modules/admin/Admin-Authentication.md.
 */

const adminLoginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type AdminLoginValues = z.infer<typeof adminLoginSchema>;

/**
 * Turn a thrown error into something an operator can act on.
 *
 * Conflating these is the real UX bug to avoid: an admin who is rate-limited and
 * told "Invalid credentials" will retry immediately, dig themselves deeper into
 * the limit, and never learn that waiting is the fix. Each case gets the one
 * sentence that tells them what to do next.
 *
 * The 401 text comes from the server, which deliberately returns the same
 * generic "Invalid credentials" for a wrong username, a wrong password, or both.
 */
function messageFor(error: unknown): string {
  if (error instanceof NetworkError) {
    return "Couldn’t reach the server. Check your connection and try again.";
  }
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return "Too many attempts. Please wait a few minutes and try again.";
    }
    if (error.status === 503) {
      return "Admin access is not configured on this server.";
    }
    return error.message; // 401 → the server's generic "Invalid credentials"
  }
  return "Something went wrong. Please try again.";
}

export default function AdminLogin() {
  const [showPassword, setShowPassword] = useState(false);
  const { login } = useAdminAuthActions();
  const navigate = useNavigate();

  const form = useForm<AdminLoginValues>({
    resolver: zodResolver(adminLoginSchema),
    defaultValues: { username: "", password: "" },
  });

  async function onSubmit(values: AdminLoginValues) {
    try {
      await login.mutateAsync(values);
      // replace: Back must not return to a login form the operator has passed.
      navigate(ROUTES.adminDashboard, { replace: true });
    } catch {
      // Surfaced via login.error below. Clear the password but keep the username:
      // retyping a username you got right is friction, and a stale password
      // sitting in a field is a shoulder-surfing risk.
      form.setValue("password", "");
    }
  }

  const busy = login.isPending;
  // Hide the previous failure the moment a retry is in flight.
  const error = login.error && !busy ? messageFor(login.error) : null;

  return (
    <PageContainer width="narrow">
      <Card className="mx-auto mt-8 max-w-sm">
        <CardHeader>
          <CardTitle>Admin sign in</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Username</FormLabel>
                    <FormControl>
                      {/* FormControl supplies id + aria-invalid/aria-describedby. */}
                      <Input {...field} autoComplete="username" autoFocus disabled={busy} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    {/*
                      The relative wrapper sits OUTSIDE FormControl deliberately.
                      FormControl forwards the id/aria-* that FormLabel points at
                      onto its single child — wrapping the Input in a div here
                      would label the DIV instead, leaving the password field
                      with no accessible name at all. Caught by F1.
                    */}
                    <div className="relative">
                      <FormControl>
                        <Input
                          {...field}
                          type={showPassword ? "text" : "password"}
                          autoComplete="current-password"
                          disabled={busy}
                          className="pr-10"
                        />
                      </FormControl>
                      {/*
                        type="button" is load-bearing: a bare <button> inside a
                        form defaults to type="submit", so toggling visibility
                        would submit the form. Pinned by F5.
                      */}
                      <button
                        type="button"
                        onClick={() => setShowPassword((shown) => !shown)}
                        disabled={busy}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Eye className="h-4 w-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {error && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
