import { Card, CardContent } from "@/shared/components/ui/card";
import { Logo } from "@/shared/components/common/Logo";
import { FadeIn } from "@/shared/components/common/Motion";
import { GoogleSignInButton } from "@/features/auth/GoogleSignInButton";
import { useFeatureFlag } from "@/shared/hooks/useFeatureFlag";

/** Google sign-in / sign-up page. */
export default function Login() {
  const oauthEnabled = useFeatureFlag("googleOAuth");

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center px-4 py-12">
      <FadeIn className="w-full">
        <Card>
          <CardContent className="flex flex-col items-center gap-6 p-8 text-center">
            <Logo withWordmark={false} className="[&_svg]:size-12" />
            <div className="space-y-1.5">
              <h1 className="text-2xl font-semibold">Sign in to Card2Contact</h1>
              <p className="text-sm text-muted-foreground">
                Connect your Google account to save scanned contacts to your own sheet.
              </p>
            </div>

            {oauthEnabled ? (
              <GoogleSignInButton className="w-full" />
            ) : (
              <p className="text-sm text-destructive">Google sign-in is currently disabled.</p>
            )}

            <p className="text-xs text-muted-foreground">
              We request access to create and update a single spreadsheet for your contacts.
            </p>
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}
