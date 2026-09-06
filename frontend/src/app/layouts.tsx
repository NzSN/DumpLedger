/**
 * Route layout shells.
 *
 * OperatorLayout — authenticated chrome (brand, primary navigation, sign out)
 * around the routed feature content.
 * PublicLayout — minimal brand + trust chip chrome for /login, /upload, and
 * the branded not-found view.
 */

import { useState, type ReactNode } from "react";
import { Outlet } from "react-router";
import {
  Brand,
  PrimaryNav,
  PublicTrustChip,
  SignOutButton,
  SiteFooter,
} from "../shared/components/navigation";
import { Notice } from "../shared/components/notice";
import { errorText, HttpRequestError } from "../shared/http-client";
import { useSession } from "./SessionProvider";

function OperatorHeader(): ReactNode {
  const { signOut } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSignOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
    } catch (error) {
      // A 401 here means the server already dropped the session; the client's
      // session-expired handling moves the operator to /login, so there is no
      // error to show.
      if (!(error instanceof HttpRequestError && error.code === "unauthenticated")) {
        setSignOutError(errorText(error, "Sign out failed."));
      }
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <Brand href="/" />
        <PrimaryNav />
        <SignOutButton onSignOut={() => void handleSignOut()} pending={signingOut} />
      </header>
      {signOutError !== null && (
        <div className="header-error">
          <Notice tone="error" role="alert">
            <p>{signOutError}</p>
          </Notice>
        </div>
      )}
    </>
  );
}

export function OperatorLayout(): ReactNode {
  return (
    <div className="app-root operator-page">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <OperatorHeader />
      <main id="content" className="page-frame">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

export function PublicLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="app-root public-page">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <header className="topbar">
        <Brand href="/login" />
        <PublicTrustChip />
      </header>
      <main id="content" className="page-frame">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
