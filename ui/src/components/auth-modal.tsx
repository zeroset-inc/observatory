import { useState } from "react"
import { Github, X } from "lucide-react"

interface AuthModalProps {
  isOpen: boolean
  onClose: () => void
  onSignIn: (email: string, password: string) => Promise<unknown>
  onSignUp: (email: string, password: string, displayName?: string) => Promise<unknown>
  onOAuthSignIn: (provider: "github" | "google") => Promise<void>
}

function GoogleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}

export function AuthModal({ isOpen, onClose, onSignIn, onSignUp, onOAuthSignIn }: AuthModalProps) {
  const [mode, setMode] = useState<"signin" | "signup" | "verify">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [verificationCode, setVerificationCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setLoading(true)

    try {
      if (mode === "signin") {
        await onSignIn(email, password)
        onClose()
        setEmail("")
        setPassword("")
      } else if (mode === "signup") {
        const result = (await onSignUp(email, password, displayName || undefined)) as
          | { needsVerification?: boolean; message?: string }
          | undefined
        if (result?.needsVerification === false) {
          setMode("signin")
          setSuccess(result.message || "Account created. You can now sign in.")
        } else {
          setMode("verify")
          setSuccess(result?.message || "Check your email for a verification code.")
        }
        setPassword("")
        setDisplayName("")
      } else if (mode === "verify") {
        const resp = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/auth/verify-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, verificationCode }),
        })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || "Verification failed")
        setMode("signin")
        setSuccess("Email verified. You can now sign in.")
        setVerificationCode("")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-bg-surface/95 backdrop-blur-xl border border-border rounded-lg w-full max-w-sm p-6 shadow-glass">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-text-muted hover:text-text-primary"
        >
          <X className="w-4 h-4" />
        </button>

        <h2 className="font-display text-lg font-medium text-text-primary mb-4">
          {mode === "signin" ? "Sign In" : mode === "signup" ? "Create Account" : "Verify Email"}
        </h2>

        {mode !== "verify" && (
          <>
            <div className="space-y-2 mb-4">
              <button
                type="button"
                onClick={() => onOAuthSignIn("github")}
                className="w-full py-2 px-4 bg-bg-primary/60 border border-border rounded-lg text-sm font-medium text-text-primary hover:bg-bg-elevated/80 transition-colors flex items-center justify-center gap-2"
              >
                <Github className="w-4 h-4" />
                Continue with GitHub
              </button>
              <button
                type="button"
                onClick={() => onOAuthSignIn("google")}
                className="w-full py-2 px-4 bg-bg-primary/60 border border-border rounded-lg text-sm font-medium text-text-primary hover:bg-bg-elevated/80 transition-colors flex items-center justify-center gap-2"
              >
                <GoogleIcon />
                Continue with Google
              </button>
            </div>

            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-text-muted">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "verify" ? (
            <>
              <p className="text-xs text-text-secondary">
                Enter the code sent to <span className="text-text-primary">{email}</span>.
              </p>
              <input
                type="text"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full px-3 py-2 bg-bg-primary/60 border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent text-center tracking-widest font-mono"
                placeholder="000000"
                maxLength={6}
                required
                autoFocus
              />
            </>
          ) : (
            <>
              {mode === "signup" && (
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="w-full px-3 py-2 bg-bg-primary/60 border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
                    placeholder="Your name"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-bg-primary/60 border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
                  placeholder="you@example.com"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-bg-primary/60 border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
                />
              </div>
            </>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
          {success && <p className="text-xs text-green-400">{success}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
          >
            {loading
              ? "..."
              : mode === "signin"
                ? "Sign In"
                : mode === "signup"
                  ? "Create Account"
                  : "Verify"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-text-muted">
          {mode === "verify" ? (
            <button
              onClick={() => {
                setMode("signin")
                setError(null)
                setSuccess(null)
              }}
              className="text-accent hover:underline"
            >
              Back to sign in
            </button>
          ) : mode === "signin" ? (
            <>
              No account?{" "}
              <button
                onClick={() => {
                  setMode("signup")
                  setError(null)
                  setSuccess(null)
                }}
                className="text-accent hover:underline"
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                onClick={() => {
                  setMode("signin")
                  setError(null)
                  setSuccess(null)
                }}
                className="text-accent hover:underline"
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
