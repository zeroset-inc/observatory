import { useState } from "react"
import { Outlet } from "react-router-dom"
import { TopNav } from "../sidebar"
import { AuthModal } from "../auth-modal"
import { useAuth } from "../../hooks/useAuth"

export function RootLayout() {
  const [showAuthModal, setShowAuthModal] = useState(false)
  const { user, signIn, signUp, signOut } = useAuth()

  const userForNav = user
    ? {
        email: user.email || "",
        displayName: user.displayName || undefined,
        avatarUrl: user.avatarUrl || undefined,
      }
    : null

  return (
    <div className="min-h-screen bg-bg-primary">
      <TopNav user={userForNav} onSignIn={() => setShowAuthModal(true)} onSignOut={signOut} />
      <main className="min-h-[calc(100vh-3.5rem)]">
        <div className="px-8 py-6 max-w-[1600px] mx-auto">
          <Outlet />
        </div>
      </main>

      <footer className="border-t border-border py-6 text-center text-xs text-text-muted">
        Built by{" "}
        <a
          href="https://zeroset.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-text-secondary hover:text-text-primary transition-colors"
        >
          Zeroset
        </a>
        {" \u00B7 "} Memory for AI agents
      </footer>

      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onSignIn={signIn}
        onSignUp={signUp}
      />
    </div>
  )
}
