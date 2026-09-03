import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  User, UserPlus, ClipboardList, ArrowUpRight, Clock, XCircle,
  Play, Search, X, Plus, Trash2, LogOut, ArrowLeft, Users, ShieldCheck, Check,
} from "lucide-react";

// --- Supabase config ---------------------------------------------------
const SUPABASE_URL = "https://ncwpwjibmtrzvvynhhlq.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jd3B3amlibXRyenZ2eW5oaGxxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE2NzQxMDMsImV4cCI6MjA2NzI1MDEwM30.TdmFBfRs8PMf0udcAfZQTK8apPj6TBPRzHW49IBXWqM";
// -------------------------------------------------------------------------

const REMEMBER_KEY = "sdf_remember_refresh_token";

async function fetchProfile(userId, accessToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const rows = await res.json();
  if (!res.ok || !rows?.length) throw new Error("Could not load profile.");
  return rows[0];
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Could not refresh session.");
  return data;
}

// ============================================================
// Root app — this is what makes navigation actually work.
// Instead of window.location.href (which has nowhere real to go
// inside an artifact preview), we keep one "which screen" state
// here and every part of the app just asks to change it.
// ============================================================
function parseRecoveryToken() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  return params.get("type") === "recovery" && params.get("access_token") ? params.get("access_token") : null;
}

export default function StudioDefineApp() {
  const [screen, setScreen] = useState("auth"); // auth | client-dashboard | coach-dashboard
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const [recoveryToken, setRecoveryToken] = useState(parseRecoveryToken);

  function handleAuthed(signInData, role, remember) {
    setSession({ ...signInData, role });
    setScreen(role === "coach" ? "coach-dashboard" : "client-dashboard");
    if (remember) {
      localStorage.setItem(REMEMBER_KEY, signInData.refresh_token);
    } else {
      localStorage.removeItem(REMEMBER_KEY);
    }
  }

  async function handleLogout() {
    const accessToken = session?.access_token;
    setSession(null);
    setScreen("auth");
    localStorage.removeItem(REMEMBER_KEY);
    if (!accessToken) return;
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      console.error("Studio Define logout error:", err);
    }
  }

  // "Keep me signed in" only stores the refresh token, never the password —
  // on load, trade it in for a fresh session instead of trusting anything
  // stale that might already be sitting in memory or storage.
  useEffect(() => {
    const savedRefreshToken = localStorage.getItem(REMEMBER_KEY);
    if (!savedRefreshToken) {
      setRestoring(false);
      return;
    }
    (async () => {
      try {
        const refreshed = await refreshAccessToken(savedRefreshToken);
        const profile = await fetchProfile(refreshed.user.id, refreshed.access_token);
        if (profile.role === "coach" && profile.status !== "approved") {
          localStorage.removeItem(REMEMBER_KEY);
        } else {
          handleAuthed(refreshed, profile.role, true);
        }
      } catch {
        localStorage.removeItem(REMEMBER_KEY);
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  // Access tokens expire in ~1hr — refresh proactively while the app stays
  // open so an active session doesn't suddenly start failing mid-use.
  useEffect(() => {
    if (!session?.refresh_token) return;
    const id = setInterval(async () => {
      try {
        const refreshed = await refreshAccessToken(session.refresh_token);
        setSession((prev) => (prev ? { ...prev, ...refreshed } : prev));
        if (localStorage.getItem(REMEMBER_KEY)) {
          localStorage.setItem(REMEMBER_KEY, refreshed.refresh_token);
        }
      } catch (err) {
        console.error("Studio Define session refresh error:", err);
      }
    }, 45 * 60 * 1000);
    return () => clearInterval(id);
  }, [session?.refresh_token]);

  if (recoveryToken) {
    return (
      <ResetPasswordScreen
        accessToken={recoveryToken}
        onDone={() => {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
          setRecoveryToken(null);
        }}
      />
    );
  }

  if (restoring) {
    return (
      <div className="min-h-screen w-full bg-[#F5F4F1] flex items-center justify-center">
        <p className="text-sm text-neutral-400">Loading…</p>
      </div>
    );
  }

  if (screen === "client-dashboard" && session) {
    return <TrainingLog session={session} onLogout={handleLogout} />;
  }
  if (screen === "coach-dashboard" && session) {
    return <CoachDashboard session={session} onLogout={handleLogout} />;
  }
  return <AuthScreen onAuthed={handleAuthed} />;
}

// ============================================================
// Reset password — the page a "forgot password" email link lands on.
// Supabase puts the recovery access_token in the URL fragment; once
// we've got it we can call /auth/v1/user directly to set a new one.
// ============================================================
function ResetPasswordScreen({ accessToken, onDone }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password needs to be at least 8 characters.");
    if (password !== confirmPassword) return setError("Passwords don't match.");

    setSubmitting(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "PUT",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.msg || data.error_description || "Could not update your password.");
      setDone(true);
    } catch (err) {
      setError(err.message || "Something went wrong. Try requesting a new reset link.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-[#F5F4F1] flex items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <p className="text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-3">
          Studio Define Fitness
        </p>
        <h2 className="text-3xl font-black tracking-tight text-neutral-900 mb-6">
          {done ? "Password updated" : "Set a new password"}
        </h2>

        {done ? (
          <>
            <p className="text-sm text-neutral-500 leading-relaxed mb-6">
              Your password has been updated. You can log in with it now.
            </p>
            <button
              type="button"
              onClick={onDone}
              className="w-full bg-neutral-900 text-white text-sm font-medium py-3.5 hover:bg-neutral-800 transition-colors"
            >
              Continue to login
            </button>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="reset-password" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
                New password
              </label>
              <input
                id="reset-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full border border-neutral-300 px-4 py-3 text-base sm:text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
              />
            </div>
            <div>
              <label htmlFor="reset-confirm" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
                Confirm new password
              </label>
              <input
                id="reset-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter your new password"
                className="w-full border border-neutral-300 px-4 py-3 text-base sm:text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-neutral-900 text-white text-sm font-medium py-3.5 hover:bg-neutral-800 transition-colors disabled:opacity-60"
            >
              {submitting ? "Saving…" : "Save new password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Auth screen — login / register for clients and coaches
// ============================================================
const TABS = [
  { key: "client-login", label: "Client login", icon: User },
  { key: "client-register", label: "Client register", icon: UserPlus },
  { key: "coach-login", label: "Coach login", icon: ClipboardList },
];

function AuthScreen({ onAuthed }) {
  const [activeTab, setActiveTab] = useState("client-login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [screen, setScreen] = useState("form"); // form | pending | rejected | check-email | forgot-password | reset-sent

  const isRegisterTab = activeTab === "client-register" || activeTab === "coach-register";
  const isCoachTab = activeTab === "coach-login" || activeTab === "coach-register";

  async function handleForgotPassword(e) {
    e.preventDefault();
    setError("");
    if (!email) return setError("Enter your email first.");

    setSubmitting(true);
    try {
      const redirectTo = encodeURIComponent(window.location.origin + window.location.pathname);
      const res = await fetch(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${redirectTo}`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.msg || data.error_description || "Could not send reset email.");
      }
      setScreen("reset-sent");
    } catch (err) {
      setError(err.message || "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function supabaseSignUp(role) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, data: { role, full_name: fullName } }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.msg || data.error_description || "Sign up failed.");
    return data;
  }

  async function supabaseSignIn() {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || "Login failed.");
    return data;
  }

  async function notifyCoachSignup(profileId, accessToken) {
    try {
      // The edge function requires *a* valid project JWT on this route, but
      // doesn't care whose — fall back to the anon key when there's no user
      // session yet (email confirmation required), so the notification still
      // fires instead of only working when auto-confirm is on.
      await fetch(`${SUPABASE_URL}/functions/v1/coach-signup-notify`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ profile_id: profileId }),
      });
    } catch (err) {
      console.error("Studio Define coach notify error:", err);
      // Sarah can still approve manually in the Supabase table editor.
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!email || !password) return setError("Enter your email and password to continue.");
    if (password.length < 8) return setError("Password needs to be at least 8 characters.");
    if (isRegisterTab && !fullName) return setError("Enter your name.");

    setSubmitting(true);
    try {
      if (isRegisterTab) {
        const role = isCoachTab ? "coach" : "client";
        const signUpData = await supabaseSignUp(role);

        // GoTrue returns the user nested under `.user` when a session is
        // issued immediately, but as the flat object itself when email
        // confirmation is required first (no session yet) — check both
        // shapes so Sarah still gets notified in the check-email case.
        const newCoachId = signUpData.user?.id || signUpData.id;
        if (role === "coach" && newCoachId) {
          await notifyCoachSignup(newCoachId, signUpData.access_token);
        }

        if (!signUpData.access_token) {
          setScreen("check-email");
        } else if (role === "coach") {
          setScreen("pending");
        } else {
          onAuthed(signUpData, "client", remember);
        }
      } else {
        const signInData = await supabaseSignIn();
        const profile = await fetchProfile(signInData.user.id, signInData.access_token);

        if (profile.role === "coach" && profile.status !== "approved") {
          setScreen(profile.status === "pending" ? "pending" : "rejected");
        } else {
          onAuthed(signInData, profile.role, remember);
        }
      }
    } catch (err) {
      console.error("Studio Define auth error:", err);
      setError(err.message || "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-[#F5F4F1] flex items-stretch justify-center">
      <div className="w-full grid grid-cols-1 md:grid-cols-2 md:min-h-screen">
        {/* LEFT: image panel */}
        <div className="relative flex flex-col justify-between overflow-hidden bg-[#3a3a38] h-[46vh] min-h-[320px] md:h-auto">
          <img
            src="/hero.jpg"
            alt=""
            className="absolute inset-0 h-full w-full object-cover contrast-105 opacity-90"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-black/50" />

          <div className="relative z-10 flex items-start justify-between gap-3 px-5 pt-5 sm:px-8 sm:pt-8 text-white">
            <span className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase shrink-0">
              01 / Training Log
            </span>
            <span className="text-[9px] sm:text-[10px] tracking-[0.1em] sm:tracking-[0.15em] font-semibold uppercase bg-white/10 border border-white/25 backdrop-blur-sm px-2.5 py-1.5 sm:px-3 text-right leading-snug">
              Motivation · Dedication · Consistency
            </span>
          </div>

          <div className="relative z-10 px-5 pb-6 sm:px-8 sm:pb-10 text-white">
            <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-white/80 mb-1.5 sm:mb-2">
              Studio Define Fitness
            </p>
            <h1 className="font-black uppercase leading-[0.9] text-4xl sm:text-6xl lg:text-7xl tracking-tight">
              Define
              <br />
              Your
              <br />
              Goals.
            </h1>
            <p className="hidden sm:block mt-5 max-w-xs text-sm text-white/85 leading-relaxed">
              Train smarter, fuel better, and feel strong, energised and in
              control of your body.
            </p>
          </div>
        </div>

        {/* RIGHT: form panel */}
        <div className="flex items-center justify-center px-5 py-8 sm:px-8 md:px-14 md:py-12">
          <div className="w-full max-w-sm">
            <p className="text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-3">
              Online coaching
            </p>
            <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-neutral-900">
              Train with purpose.
            </h2>
            <p className="mt-3 text-sm text-neutral-500 leading-relaxed">
              Your private training record for accountability, consistency,
              and sustainable results.
            </p>

            <div role="tablist" className="mt-8 flex items-center gap-4 sm:gap-6 border-b border-neutral-200 overflow-x-auto scrollbar-hide -mx-1 px-1">
              {TABS.map(({ key, label, icon: Icon }) => {
                const active = activeTab === key || (key === "coach-login" && activeTab === "coach-register");
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setActiveTab(key);
                      setError("");
                      setScreen("form");
                    }}
                    className={`flex items-center gap-1.5 pb-3 text-sm whitespace-nowrap shrink-0 transition-colors border-b-2 -mb-px ${
                      active
                        ? "border-neutral-900 text-neutral-900 font-medium"
                        : "border-transparent text-neutral-400 hover:text-neutral-600"
                    }`}
                  >
                    <Icon size={14} strokeWidth={2} />
                    {label}
                  </button>
                );
              })}
            </div>

            {activeTab === "coach-register" && (
              <p className="mt-6 text-sm font-medium text-neutral-900">Coach registration</p>
            )}

            {screen === "pending" && (
              <div className="mt-8 border border-neutral-200 p-6 text-center">
                <Clock className="mx-auto mb-3 text-neutral-400" size={28} strokeWidth={1.5} />
                <h3 className="font-semibold text-neutral-900">Awaiting approval</h3>
                <p className="mt-2 text-sm text-neutral-500 leading-relaxed">
                  Your coach account has been created and is waiting on
                  approval from Studio Define Fitness. You'll be able to log
                  in once it's approved.
                </p>
              </div>
            )}

            {screen === "rejected" && (
              <div className="mt-8 border border-neutral-200 p-6 text-center">
                <XCircle className="mx-auto mb-3 text-neutral-400" size={28} strokeWidth={1.5} />
                <h3 className="font-semibold text-neutral-900">Account not approved</h3>
                <p className="mt-2 text-sm text-neutral-500 leading-relaxed">
                  This coach account wasn't approved. Contact Studio Define
                  Fitness directly if you think this is a mistake.
                </p>
              </div>
            )}

            {screen === "check-email" && (
              <div className="mt-8 border border-neutral-200 p-6 text-center">
                <h3 className="font-semibold text-neutral-900">Check your email</h3>
                <p className="mt-2 text-sm text-neutral-500 leading-relaxed">
                  We've sent a confirmation link to {email}. Confirm your
                  address, then come back and log in.
                </p>
              </div>
            )}

            {screen === "forgot-password" && (
              <form onSubmit={handleForgotPassword} className="mt-7 space-y-5">
                <p className="text-sm text-neutral-500 leading-relaxed">
                  Enter your email and we'll send you a link to set a new password.
                </p>
                <div>
                  <label htmlFor="forgot-email" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
                    Email
                  </label>
                  <input
                    id="forgot-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full border border-neutral-300 px-4 py-3 text-base sm:text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
                  />
                </div>

                {error && (
                  <p className="text-sm text-red-600" role="alert">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-neutral-900 text-white text-sm font-medium py-3.5 hover:bg-neutral-800 transition-colors disabled:opacity-60"
                >
                  {submitting ? "Sending…" : "Send reset link"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError("");
                    setScreen("form");
                  }}
                  className="w-full text-sm text-neutral-500 hover:text-neutral-900"
                >
                  Back to login
                </button>
              </form>
            )}

            {screen === "reset-sent" && (
              <div className="mt-8 border border-neutral-200 p-6 text-center">
                <h3 className="font-semibold text-neutral-900">Check your email</h3>
                <p className="mt-2 text-sm text-neutral-500 leading-relaxed">
                  If an account exists for {email}, we've sent a link to reset
                  your password.
                </p>
                <button
                  type="button"
                  onClick={() => setScreen("form")}
                  className="mt-4 text-sm text-neutral-500 hover:text-neutral-900 underline"
                >
                  Back to login
                </button>
              </div>
            )}

            {screen === "form" && (
              <form onSubmit={handleSubmit} className="mt-7 space-y-5">
                {isRegisterTab && (
                  <div>
                    <label htmlFor="auth-full-name" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
                      Full name
                    </label>
                    <input
                      id="auth-full-name"
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Jane Smith"
                      className="w-full border border-neutral-300 px-4 py-3 text-base sm:text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
                    />
                  </div>
                )}

                <div>
                  <label htmlFor="auth-email" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
                    Email
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full border border-neutral-300 px-4 py-3 text-base sm:text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
                  />
                </div>

                <div>
                  <label htmlFor="auth-password" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
                    Password
                  </label>
                  <input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="w-full border border-neutral-300 px-4 py-3 text-base sm:text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
                  />
                  {!isRegisterTab && (
                    <button
                      type="button"
                      onClick={() => {
                        setError("");
                        setScreen("forgot-password");
                      }}
                      className="mt-2 text-xs text-neutral-500 hover:text-neutral-900 underline"
                    >
                      Forgot your password?
                    </button>
                  )}
                </div>

                {error && (
                  <p className="text-sm text-red-600" role="alert">
                    {error}
                  </p>
                )}

                <label className="flex items-start gap-2.5 text-sm text-neutral-500 cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="mt-0.5 h-5 w-5 sm:h-4 sm:w-4 shrink-0 border-neutral-300 accent-neutral-900"
                  />
                  <span>
                    Keep me signed in on this device. Your password is
                    never stored.
                  </span>
                </label>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 bg-neutral-900 text-white text-base sm:text-sm font-medium py-3.5 hover:bg-neutral-800 active:bg-neutral-700 transition-colors disabled:opacity-60"
                >
                  {submitting
                    ? "Please wait…"
                    : isRegisterTab
                    ? "Create my account"
                    : isCoachTab
                    ? "Continue to coach dashboard"
                    : "Continue to my log"}
                  <ArrowUpRight size={16} strokeWidth={2} />
                </button>

                {activeTab === "client-login" && (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab("client-register");
                      setError("");
                    }}
                    className="text-sm text-neutral-600 underline underline-offset-2 hover:text-neutral-900 py-1"
                  >
                    New to studiodefinefitness.au? Register here
                  </button>
                )}

                {activeTab === "coach-login" && (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab("coach-register");
                      setError("");
                    }}
                    className="text-sm text-neutral-600 underline underline-offset-2 hover:text-neutral-900 py-1"
                  >
                    New coach? Register here
                  </button>
                )}
              </form>
            )}

            <p className="mt-10 text-xs text-neutral-400 leading-relaxed">
              By continuing, you agree to use this log for your own training
              record and coach review.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Client dashboard — Training Log
// ============================================================
const CATEGORIES = [
  "Strength Training",
  "Sprint Interval Training",
  "High Intensity Interval Training",
  "Plyometrics",
  "Deload",
];

// Short forms for the workout history list, where space is tight on mobile.
const CATEGORY_ABBREVIATIONS = {
  "Strength Training": "ST",
  "Sprint Interval Training": "SIT",
  "High Intensity Interval Training": "HIT",
};
function abbreviateCategory(cat) {
  return CATEGORY_ABBREVIATIONS[cat] || cat;
}

// ------------------------------------------------------------
// Per-set logging: each exercise in a workout holds an array of
// individual sets (own weight/reps/RPE/tag/completion), matching how
// people actually train — set 3 might be lighter than set 1, or the
// last one taken to failure.
// ------------------------------------------------------------
const SET_TYPES = [
  { value: "normal", label: "Normal" },
  { value: "warmup", label: "Warm-up" },
  { value: "drop", label: "Drop set" },
  { value: "failure", label: "Failure" },
];
const SET_TYPE_STYLES = {
  normal: "border-neutral-300 text-neutral-700 bg-white",
  warmup: "border-amber-300 text-amber-700 bg-amber-50",
  drop: "border-purple-300 text-purple-700 bg-purple-50",
  failure: "border-red-300 text-red-700 bg-red-50",
};

function newSet(prevSet) {
  return {
    id: crypto.randomUUID(),
    weight: prevSet?.weight ?? "",
    reps: prevSet?.reps ?? "",
    time: prevSet?.time ?? "",
    rpe: "",
    type: "normal",
    completed: false,
    completedAt: null,
  };
}

// Old saved workouts (before per-set logging) stored one row per exercise
// as {weight, reps, time, rest, sets: "3"} — a single prescription, not
// individual sets. Expand that into N identical set rows so old data still
// displays and edits correctly; new saves always use the array shape.
function hydrateExerciseEntry(entry) {
  if (Array.isArray(entry.sets)) {
    return {
      id: crypto.randomUUID(),
      exercise: entry.exercise,
      category: entry.category,
      restMinutes: String(entry.restMinutes ?? entry.rest ?? "1"),
      sets: entry.sets.map((s) => ({
        id: crypto.randomUUID(),
        weight: s.weight ?? "",
        reps: s.reps ?? "",
        time: s.time ?? "",
        rpe: s.rpe ?? "",
        type: s.type || "normal",
        completed: !!s.completed,
        completedAt: s.completedAt || null,
      })),
    };
  }
  const count = Math.max(1, parseInt(entry.sets, 10) || 1);
  return {
    id: crypto.randomUUID(),
    exercise: entry.exercise,
    category: entry.category,
    restMinutes: String(entry.rest ?? "1"),
    sets: Array.from({ length: count }, () => ({
      id: crypto.randomUUID(),
      weight: entry.weight ?? "",
      reps: entry.reps ?? "",
      time: entry.time ?? "",
      rpe: "",
      type: "normal",
      completed: true,
      completedAt: null,
    })),
  };
}

function formatRestClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function requestRestNotificationPermission() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch {
    // Notifications just won't fire — the on-screen timer still works.
  }
}

function notifyRestDone() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("Rest complete", { body: "Time for your next set." });
    }
  } catch {
    // Ignore — visual timer already shows 0:00.
  }
  try {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch {
    // Vibration API isn't available on this device — fine.
  }
}

function playRestBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  } catch {
    // No Web Audio support — silent fallback, timer is still visible.
  }
}

const REST_TIMER_STORAGE_KEY = "sdf_rest_timer";

// A rest timer keyed to an absolute end timestamp (not a decrementing
// counter) so it stays correct across a backgrounded tab or a page reload
// mid-rest — restored from localStorage on mount.
function useRestTimer() {
  const [restEndsAt, setRestEndsAt] = useState(null);
  const [restDurationSec, setRestDurationSec] = useState(0);
  const [restLabel, setRestLabel] = useState("");
  const [restRemaining, setRestRemaining] = useState(0);
  const [restPaused, setRestPaused] = useState(false);
  const [restPausedRemaining, setRestPausedRemaining] = useState(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(REST_TIMER_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.paused) {
        setRestPaused(true);
        setRestPausedRemaining(saved.remaining);
        setRestDurationSec(saved.duration);
        setRestLabel(saved.label || "");
      } else if (saved.endsAt && saved.endsAt > Date.now()) {
        setRestEndsAt(saved.endsAt);
        setRestDurationSec(saved.duration);
        setRestLabel(saved.label || "");
      } else {
        localStorage.removeItem(REST_TIMER_STORAGE_KEY);
      }
    } catch {
      // No stored timer, or it's corrupt — just start fresh.
    }
  }, []);

  function persist(state) {
    try {
      if (!state) localStorage.removeItem(REST_TIMER_STORAGE_KEY);
      else localStorage.setItem(REST_TIMER_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Best-effort only — the in-memory timer still works this session.
    }
  }

  useEffect(() => {
    if (!restEndsAt || restPaused) return;
    const tick = () => {
      const remaining = Math.max(0, Math.round((restEndsAt - Date.now()) / 1000));
      setRestRemaining(remaining);
      if (remaining <= 0) {
        setRestEndsAt(null);
        persist(null);
        playRestBeep();
        notifyRestDone();
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [restEndsAt, restPaused]);

  function startRestTimer(seconds, label) {
    if (!seconds || seconds <= 0) return;
    const endsAt = Date.now() + seconds * 1000;
    setRestEndsAt(endsAt);
    setRestDurationSec(seconds);
    setRestLabel(label || "");
    setRestPaused(false);
    setRestRemaining(seconds);
    persist({ endsAt, duration: seconds, label: label || "", paused: false });
    requestRestNotificationPermission();
  }

  function adjustRestTimer(deltaSec) {
    if (restPaused) {
      const next = Math.max(0, restPausedRemaining + deltaSec);
      setRestPausedRemaining(next);
      persist({ paused: true, remaining: next, duration: restDurationSec, label: restLabel });
      return;
    }
    if (!restEndsAt) return;
    const nextEndsAt = Math.max(Date.now(), restEndsAt + deltaSec * 1000);
    setRestEndsAt(nextEndsAt);
    persist({ endsAt: nextEndsAt, duration: restDurationSec, label: restLabel, paused: false });
  }

  function pauseResumeRestTimer() {
    if (restPaused) {
      const endsAt = Date.now() + restPausedRemaining * 1000;
      setRestEndsAt(endsAt);
      setRestPaused(false);
      persist({ endsAt, duration: restDurationSec, label: restLabel, paused: false });
    } else {
      if (!restEndsAt) return;
      const remaining = Math.max(0, Math.round((restEndsAt - Date.now()) / 1000));
      setRestPausedRemaining(remaining);
      setRestPaused(true);
      setRestEndsAt(null);
      persist({ paused: true, remaining, duration: restDurationSec, label: restLabel });
    }
  }

  function skipRestTimer() {
    setRestEndsAt(null);
    setRestPaused(false);
    setRestRemaining(0);
    persist(null);
  }

  return {
    restActive: !!restEndsAt || restPaused,
    restRemaining: restPaused ? restPausedRemaining : restRemaining,
    restLabel,
    restPaused,
    startRestTimer,
    adjustRestTimer,
    pauseResumeRestTimer,
    skipRestTimer,
  };
}

const EXERCISE_LIBRARY = [
  "Ab Crunch Machine", "Arnold Press", "Assault Bike Sprint", "Assisted Dip", "Assisted Pull-Up",
  "Back Extension", "Back Squat", "Band Pull-Apart", "Barbell Curl", "Barbell Row",
  "Battle Ropes", "Bear Crawl", "Bench Press", "Bent-Over Row", "Bicycle Crunch",
  "Biceps Curl", "Bird Dog", "Bounding", "Box Jump", "Broad Jump",
  "Bulgarian Split Squat", "Burpee", "Cable Crossover", "Cable Kickback", "Cable Lateral Raise",
  "Cable Row", "Calf Raise", "Cat-Cow Stretch", "Chest Fly", "Child's Pose",
  "Chin-Up", "Clap Push-Up", "Clean and Jerk", "Close-Grip Bench Press", "Concentration Curl",
  "Dead Bug", "Deadlift", "Decline Bench Press", "Deficit Deadlift", "Depth Jump",
  "Devil Press", "Double Unders", "Dumbbell Fly", "Dumbbell Press", "Dumbbell Row",
  "EZ-Bar Curl", "Face Pull", "Farmer's Carry", "Flutter Kicks", "Front Squat",
  "Glute Bridge", "Glute Kickback Machine", "Goblet Squat", "Good Morning", "Hack Squat",
  "Hammer Curl", "Hanging Leg Raise", "High Knees", "Hill Sprints", "Hip Flexor Stretch",
  "Hip Thrust", "Incline Bench Press", "Jump Rope", "Jump Squat", "Jumping Jacks",
  "Kettlebell Swing", "Landmine Press", "Lat Pulldown", "Lateral Bound", "Lateral Raise",
  "Leg Abduction", "Leg Adduction", "Leg Curl", "Leg Extension", "Leg Press",
  "Lunges", "Lying Leg Curl", "Machine Bicep Curl", "Machine Chest Press", "Machine Lateral Raise",
  "Machine Shoulder Press", "Man Makers", "Medicine Ball Chest Pass", "Medicine Ball Slam", "Mountain Climbers",
  "Overhead Press", "Pec Deck", "Pendlay Row", "Pistol Squat", "Plank",
  "Plyo Push-Up", "Preacher Curl", "Pull-Up", "Push Press", "Push-Up",
  "Renegade Row", "Reverse Fly", "Reverse Hyperextension", "Reverse Lunge", "Romanian Deadlift",
  "Rotary Torso", "Rowing Sprint", "Russian Twist", "Seated Calf Raise", "Seated Row",
  "Shoulder Press", "Shrugs", "Shuttle Runs", "Side Plank", "Single-Arm Dumbbell Row",
  "Single-Leg Hop", "Skater Jump", "Ski Erg Sprint", "Skull Crusher", "Sled Push",
  "Smith Machine Bench Press", "Smith Machine Shoulder Press", "Smith Machine Squat", "Snatch", "Sprint (Track)",
  "Squat Jump", "Stair Sprints", "Standing Calf Raise", "Standing Hamstring Stretch", "Star Jump",
  "Stationary Bike Sprint", "Step-Up", "Sumo Deadlift", "T-Bar Row", "Thoracic Rotation",
  "Thruster", "Trap Bar Deadlift", "Treadmill Sprint", "Tricep Dip", "Tricep Pushdown",
  "Tuck Jump", "Turkish Get-Up", "Upright Row", "V-Up", "Wall Ball",
  "Wall Sit", "World's Greatest Stretch", "Zercher Squat", "Zottman Curl",
];

// Which workout categories each exercise belongs to — an exercise can fit
// more than one (e.g. a kettlebell swing is used in both strength and HIIT
// sessions). Drives the category filter on the exercise library list.
const EXERCISE_CATEGORIES = {
  "Arnold Press": ["Strength Training"],
  "Back Extension": ["Strength Training"],
  "Back Squat": ["Strength Training"],
  "Barbell Row": ["Strength Training"],
  "Battle Ropes": ["Sprint Interval Training", "High Intensity Interval Training"],
  "Bench Press": ["Strength Training"],
  "Bent-Over Row": ["Strength Training"],
  "Biceps Curl": ["Strength Training"],
  "Box Jump": ["Plyometrics", "High Intensity Interval Training"],
  "Bulgarian Split Squat": ["Strength Training"],
  "Burpee": ["High Intensity Interval Training", "Plyometrics"],
  "Cable Crossover": ["Strength Training", "Deload"],
  "Cable Row": ["Strength Training", "Deload"],
  "Calf Raise": ["Strength Training"],
  "Chest Fly": ["Strength Training"],
  "Chin-Up": ["Strength Training"],
  "Clean and Jerk": ["Strength Training", "High Intensity Interval Training"],
  "Close-Grip Bench Press": ["Strength Training"],
  "Concentration Curl": ["Strength Training"],
  "Deadlift": ["Strength Training"],
  "Deficit Deadlift": ["Strength Training"],
  "Dumbbell Press": ["Strength Training"],
  "Dumbbell Row": ["Strength Training"],
  "Face Pull": ["Strength Training", "Deload"],
  "Farmer's Carry": ["Strength Training", "High Intensity Interval Training"],
  "Front Squat": ["Strength Training"],
  "Glute Bridge": ["Strength Training", "Deload"],
  "Goblet Squat": ["Strength Training"],
  "Hack Squat": ["Strength Training"],
  "Hammer Curl": ["Strength Training"],
  "Hanging Leg Raise": ["Strength Training"],
  "Hip Thrust": ["Strength Training"],
  "Incline Bench Press": ["Strength Training"],
  "Jump Rope": ["Sprint Interval Training", "High Intensity Interval Training"],
  "Jump Squat": ["Plyometrics", "High Intensity Interval Training"],
  "Kettlebell Swing": ["High Intensity Interval Training", "Strength Training", "Sprint Interval Training"],
  "Lat Pulldown": ["Strength Training", "Deload"],
  "Lateral Raise": ["Strength Training"],
  "Leg Curl": ["Strength Training", "Deload"],
  "Leg Extension": ["Strength Training", "Deload"],
  "Leg Press": ["Strength Training", "Deload"],
  "Lunges": ["Strength Training"],
  "Mountain Climbers": ["High Intensity Interval Training"],
  "Overhead Press": ["Strength Training"],
  "Pistol Squat": ["Strength Training", "Plyometrics"],
  "Plank": ["Deload", "Strength Training"],
  "Plyo Push-Up": ["Plyometrics", "High Intensity Interval Training"],
  "Pull-Up": ["Strength Training"],
  "Push Press": ["Strength Training", "High Intensity Interval Training"],
  "Push-Up": ["Strength Training", "Deload"],
  "Renegade Row": ["Strength Training", "High Intensity Interval Training"],
  "Reverse Lunge": ["Strength Training"],
  "Romanian Deadlift": ["Strength Training"],
  "Rowing Sprint": ["Sprint Interval Training", "High Intensity Interval Training"],
  "Russian Twist": ["High Intensity Interval Training", "Deload"],
  "Seated Row": ["Strength Training", "Deload"],
  "Shoulder Press": ["Strength Training"],
  "Shrugs": ["Strength Training"],
  "Side Plank": ["Deload", "Strength Training"],
  "Skater Jump": ["Plyometrics", "High Intensity Interval Training"],
  "Sled Push": ["Sprint Interval Training", "High Intensity Interval Training"],
  "Snatch": ["Strength Training", "High Intensity Interval Training"],
  "Sprint (Track)": ["Sprint Interval Training"],
  "Squat Jump": ["Plyometrics", "High Intensity Interval Training"],
  "Standing Calf Raise": ["Strength Training", "Deload"],
  "Step-Up": ["Strength Training"],
  "Sumo Deadlift": ["Strength Training"],
  "T-Bar Row": ["Strength Training"],
  "Thruster": ["High Intensity Interval Training", "Strength Training"],
  "Tricep Dip": ["Strength Training"],
  "Tricep Pushdown": ["Strength Training"],
  "Turkish Get-Up": ["Strength Training", "Deload"],
  "Upright Row": ["Strength Training"],
  "Wall Ball": ["High Intensity Interval Training"],
  "Wall Sit": ["Deload", "Strength Training"],

  "Assault Bike Sprint": ["Sprint Interval Training", "High Intensity Interval Training"],
  "Band Pull-Apart": ["Deload", "Strength Training"],
  "Barbell Curl": ["Strength Training"],
  "Bear Crawl": ["High Intensity Interval Training"],
  "Bicycle Crunch": ["High Intensity Interval Training", "Deload"],
  "Bird Dog": ["Deload", "Strength Training"],
  "Bounding": ["Plyometrics"],
  "Broad Jump": ["Plyometrics", "High Intensity Interval Training"],
  "Cable Kickback": ["Strength Training", "Deload"],
  "Cable Lateral Raise": ["Strength Training", "Deload"],
  "Cat-Cow Stretch": ["Deload"],
  "Child's Pose": ["Deload"],
  "Clap Push-Up": ["Plyometrics", "High Intensity Interval Training"],
  "Dead Bug": ["Deload", "Strength Training"],
  "Decline Bench Press": ["Strength Training"],
  "Depth Jump": ["Plyometrics"],
  "Devil Press": ["High Intensity Interval Training"],
  "Double Unders": ["Sprint Interval Training", "High Intensity Interval Training"],
  "Dumbbell Fly": ["Strength Training"],
  "EZ-Bar Curl": ["Strength Training"],
  "Flutter Kicks": ["High Intensity Interval Training", "Deload"],
  "Good Morning": ["Strength Training"],
  "High Knees": ["High Intensity Interval Training"],
  "Hill Sprints": ["Sprint Interval Training"],
  "Hip Flexor Stretch": ["Deload"],
  "Jumping Jacks": ["High Intensity Interval Training"],
  "Landmine Press": ["Strength Training"],
  "Lateral Bound": ["Plyometrics"],
  "Leg Abduction": ["Strength Training", "Deload"],
  "Leg Adduction": ["Strength Training", "Deload"],
  "Machine Chest Press": ["Strength Training", "Deload"],
  "Man Makers": ["High Intensity Interval Training"],
  "Medicine Ball Chest Pass": ["Plyometrics", "High Intensity Interval Training"],
  "Medicine Ball Slam": ["High Intensity Interval Training"],
  "Pendlay Row": ["Strength Training"],
  "Preacher Curl": ["Strength Training"],
  "Reverse Fly": ["Strength Training"],
  "Seated Calf Raise": ["Strength Training", "Deload"],
  "Shuttle Runs": ["Sprint Interval Training"],
  "Single-Arm Dumbbell Row": ["Strength Training"],
  "Single-Leg Hop": ["Plyometrics"],
  "Ski Erg Sprint": ["Sprint Interval Training", "High Intensity Interval Training"],
  "Skull Crusher": ["Strength Training"],
  "Stair Sprints": ["Sprint Interval Training"],
  "Standing Hamstring Stretch": ["Deload"],
  "Star Jump": ["Plyometrics", "High Intensity Interval Training"],
  "Stationary Bike Sprint": ["Sprint Interval Training", "High Intensity Interval Training"],
  "Thoracic Rotation": ["Deload"],
  "Trap Bar Deadlift": ["Strength Training"],
  "Tuck Jump": ["Plyometrics", "High Intensity Interval Training"],
  "V-Up": ["High Intensity Interval Training"],
  "World's Greatest Stretch": ["Deload"],
  "Zercher Squat": ["Strength Training"],
  "Zottman Curl": ["Strength Training"],

  "Ab Crunch Machine": ["Strength Training"],
  "Assisted Dip": ["Strength Training", "Deload"],
  "Assisted Pull-Up": ["Strength Training", "Deload"],
  "Glute Kickback Machine": ["Strength Training"],
  "Lying Leg Curl": ["Strength Training", "Deload"],
  "Machine Bicep Curl": ["Strength Training"],
  "Machine Lateral Raise": ["Strength Training"],
  "Machine Shoulder Press": ["Strength Training", "Deload"],
  "Pec Deck": ["Strength Training", "Deload"],
  "Reverse Hyperextension": ["Strength Training"],
  "Rotary Torso": ["Strength Training"],
  "Smith Machine Bench Press": ["Strength Training"],
  "Smith Machine Shoulder Press": ["Strength Training"],
  "Smith Machine Squat": ["Strength Training"],
  "Treadmill Sprint": ["Sprint Interval Training", "High Intensity Interval Training"],
};

// Per-exercise form guides shown in the library detail modal. Only a few
// are filled in as a proof of concept — the rest fall back to a
// "coming soon" state in ExerciseDetailModal until this is built out.
const EXERCISE_DETAILS = {
  "Back Squat": {
    muscles: {
      primary: ["Quadriceps", "Glutes"],
      secondary: ["Hamstrings", "Lower back", "Core"],
    },
    steps: [
      "Set the barbell on a rack at about shoulder height and step under it, resting the bar across your upper traps — not your neck.",
      "Grip the bar just outside shoulder width, lift it off the rack, and step back into a stance about shoulder-width apart with toes turned slightly out.",
      "Brace your core, keep your chest up, and push your hips back as you bend your knees to start lowering down.",
      "Descend until your thighs are at least parallel to the floor, keeping your knees tracking over your toes and your heels flat on the ground.",
      "Drive through your heels and mid-foot to stand back up, keeping your chest up and your back neutral throughout.",
      "Fully extend your hips and knees at the top without leaning back, then repeat.",
    ],
  },
};

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// A simplified front/back body silhouette with the worked muscles shaded.
// Same illustration technique for both — the outline is identical, only
// the highlighted regions differ between the front and back copy.
function MuscleMap({ primary = [], secondary = [] }) {
  const body = (cx) => (
    <>
      <circle cx={cx} cy="60" r="18" fill="#E8B792" />
      <line x1={cx} y1="78" x2={cx} y2="90" stroke="#E8B792" strokeWidth="14" strokeLinecap="round" />
      <line x1={cx} y1="90" x2={cx} y2="210" stroke="#C7C7C7" strokeWidth="70" strokeLinecap="round" />
      <line x1={cx - 35} y1="100" x2={cx - 45} y2="205" stroke="#E8B792" strokeWidth="16" strokeLinecap="round" />
      <line x1={cx + 35} y1="100" x2={cx + 45} y2="205" stroke="#E8B792" strokeWidth="16" strokeLinecap="round" />
      <line x1={cx - 18} y1="205" x2={cx - 20} y2="290" stroke="#E8B792" strokeWidth="26" strokeLinecap="round" />
      <line x1={cx + 18} y1="205" x2={cx + 20} y2="290" stroke="#E8B792" strokeWidth="26" strokeLinecap="round" />
      <line x1={cx - 20} y1="290" x2={cx - 20} y2="380" stroke="#E8B792" strokeWidth="20" strokeLinecap="round" />
      <line x1={cx + 20} y1="290" x2={cx + 20} y2="380" stroke="#E8B792" strokeWidth="20" strokeLinecap="round" />
    </>
  );

  const has = (list, name) => list.some((m) => m.toLowerCase() === name.toLowerCase());

  return (
    <svg width="100%" viewBox="0 0 680 460" role="img">
      <title>Muscles worked</title>
      <desc>Front and back body outline highlighting the primary and secondary muscles worked by this exercise.</desc>

      {body(170)}
      {has(primary, "Quadriceps") && (
        <>
          <ellipse cx="150" cy="255" rx="16" ry="45" fill="#E76F51" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.9" />
          <ellipse cx="190" cy="255" rx="16" ry="45" fill="#E76F51" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.9" />
        </>
      )}
      {has(secondary, "Core") && <rect x="148" y="150" width="44" height="55" rx="8" fill="#2A9D8F" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.9" />}

      {body(510)}
      {has(primary, "Glutes") && <ellipse cx="510" cy="215" rx="30" ry="22" fill="#E76F51" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.9" />}
      {has(secondary, "Hamstrings") && (
        <>
          <ellipse cx="490" cy="265" rx="14" ry="40" fill="#2A9D8F" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.9" />
          <ellipse cx="530" cy="265" rx="14" ry="40" fill="#2A9D8F" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.9" />
        </>
      )}
      {has(secondary, "Lower back") && <rect x="492" y="155" width="36" height="40" rx="8" fill="#2A9D8F" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.8" />}

      <text x="170" y="415" fill="#171717" fontSize="14" textAnchor="middle">Front</text>
      <text x="510" y="415" fill="#171717" fontSize="14" textAnchor="middle">Back</text>

      <circle cx="240" cy="445" r="6" fill="#E76F51" />
      <text x="252" y="449" fill="#737373" fontSize="12" textAnchor="start">Primary</text>
      <circle cx="340" cy="445" r="6" fill="#2A9D8F" />
      <text x="352" y="449" fill="#737373" fontSize="12" textAnchor="start">Secondary</text>
    </svg>
  );
}

function ExerciseDetailModal({ name, onClose, onAdd }) {
  const detail = EXERCISE_DETAILS[name];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-white w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={name}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200 sticky top-0 bg-white">
          <h3 className="text-lg font-bold text-neutral-900">{name}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-900">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-6">
          <div className="aspect-video bg-neutral-100 border border-neutral-200 flex flex-col items-center justify-center gap-2 text-neutral-400">
            <Play size={28} strokeWidth={1.5} />
            <p className="text-xs text-center px-6">
              Video demonstration — connect an exercise database API to enable this.
            </p>
          </div>

          {detail ? (
            <>
              <div>
                <MuscleMap primary={detail.muscles.primary} secondary={detail.muscles.secondary} />
              </div>

              <div>
                <p className="text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-3">
                  How to do it
                </p>
                <ol className="space-y-2.5">
                  {detail.steps.map((step, i) => (
                    <li key={i} className="flex gap-3 text-sm text-neutral-700 leading-relaxed">
                      <span className="shrink-0 font-semibold text-neutral-400">{i + 1}.</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          ) : (
            <p className="text-sm text-neutral-500">
              A detailed guide for this exercise is coming soon.
            </p>
          )}
        </div>

        <div className="flex gap-3 px-5 py-4 border-t border-neutral-200 sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={onAdd}
            className="flex-1 flex items-center justify-center gap-1.5 bg-neutral-900 text-white text-sm font-medium py-3 hover:bg-neutral-800 transition-colors"
          >
            <Plus size={14} /> Add to workout
          </button>
        </div>
      </div>
    </div>
  );
}

const KG_PER_LB = 0.45359237;
const CM_PER_IN = 2.54;
const ACTIVITY_LEVELS = ["Sedentary", "Lightly active", "Moderately active", "Very active", "Extremely active"];

function kgToDisplay(kg, units) {
  if (kg == null || kg === "") return "";
  const n = units === "imperial" ? kg / KG_PER_LB : kg;
  return String(Math.round(n * 10) / 10);
}
function displayToKg(value, units) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return units === "imperial" ? n * KG_PER_LB : n;
}
function cmToDisplay(cm, units) {
  if (cm == null || cm === "") return "";
  const n = units === "imperial" ? cm / CM_PER_IN : cm;
  return String(Math.round(n * 10) / 10);
}
function displayToCm(value, units) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(units === "imperial" ? n * CM_PER_IN : n);
}

// Quick reference for a coach entering weights for a client who tracks in a
// different unit than the coach is used to thinking in — not tied to any
// saved data, just a live two-way kg/lbs calculator.
function WeightConverter() {
  const [kg, setKg] = useState("");
  const [lbs, setLbs] = useState("");

  function handleKgChange(value) {
    setKg(value);
    const n = Number(value);
    setLbs(value.trim() !== "" && Number.isFinite(n) ? String(Math.round((n / KG_PER_LB) * 10) / 10) : "");
  }

  function handleLbsChange(value) {
    setLbs(value);
    const n = Number(value);
    setKg(value.trim() !== "" && Number.isFinite(n) ? String(Math.round(n * KG_PER_LB * 10) / 10) : "");
  }

  return (
    <div className="border border-neutral-200 bg-neutral-50 p-4 mb-4">
      <p className="text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-3">
        Weight converter
      </p>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label htmlFor="conv-kg" className="block text-xs text-neutral-500 mb-1">kg</label>
          <input
            id="conv-kg"
            type="text"
            inputMode="decimal"
            value={kg}
            onChange={(e) => handleKgChange(e.target.value)}
            className="w-full border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
          />
        </div>
        <span className="text-neutral-400 pb-2">=</span>
        <div className="flex-1">
          <label htmlFor="conv-lbs" className="block text-xs text-neutral-500 mb-1">lbs</label>
          <input
            id="conv-lbs"
            type="text"
            inputMode="decimal"
            value={lbs}
            onChange={(e) => handleLbsChange(e.target.value)}
            className="w-full border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
          />
        </div>
      </div>
    </div>
  );
}

function ProfileModal({ session, profile, onClose, onSaved }) {
  const [units, setUnits] = useState(profile.measurement_system === "imperial" ? "imperial" : "metric");
  const [weight, setWeight] = useState(kgToDisplay(profile.weight_kg, units));
  const [goalWeight, setGoalWeight] = useState(kgToDisplay(profile.goal_weight_kg, units));
  const [height, setHeight] = useState(cmToDisplay(profile.height_cm, units));
  const [dob, setDob] = useState(profile.date_of_birth || "");
  const [activityLevel, setActivityLevel] = useState(profile.activity_level || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function handleUnitsChange(nextUnits) {
    if (nextUnits === units) return;
    const weightKg = displayToKg(weight, units);
    const goalKg = displayToKg(goalWeight, units);
    const heightCm = displayToCm(height, units);
    setWeight(kgToDisplay(weightKg, nextUnits));
    setGoalWeight(kgToDisplay(goalKg, nextUnits));
    setHeight(cmToDisplay(heightCm, nextUnits));
    setUnits(nextUnits);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError("");

    if (weight.trim() !== "" && !(Number(weight) > 0)) {
      setError("Enter a valid body weight, or leave it blank.");
      return;
    }
    if (goalWeight.trim() !== "" && !(Number(goalWeight) > 0)) {
      setError("Enter a valid goal weight, or leave it blank.");
      return;
    }
    if (height.trim() !== "" && !(Number(height) > 0)) {
      setError("Enter a valid height, or leave it blank.");
      return;
    }

    setSaving(true);
    try {
      const body = {
        measurement_system: units,
        weight_kg: weight.trim() === "" ? null : displayToKg(weight, units),
        goal_weight_kg: goalWeight.trim() === "" ? null : displayToKg(goalWeight, units),
        height_cm: height.trim() === "" ? null : displayToCm(height, units),
        date_of_birth: dob || null,
        activity_level: activityLevel || null,
      };
      const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${session.user.id}`, {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Could not save your profile.");
      const rows = await res.json();
      setSaved(true);
      onSaved(rows[0] || { ...profile, ...body });
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message || "Something went wrong saving your profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-white w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Your profile"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200 sticky top-0 bg-white">
          <h3 className="text-lg font-bold text-neutral-900">Your profile</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-900">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-5 space-y-5">
          <div>
            <label className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
              Units
            </label>
            <div className="flex gap-2">
              {["metric", "imperial"].map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => handleUnitsChange(opt)}
                  className={`flex-1 py-2 text-sm font-medium border transition-colors ${
                    units === opt
                      ? "bg-neutral-900 text-white border-neutral-900"
                      : "bg-white text-neutral-700 border-neutral-300 hover:border-neutral-400"
                  }`}
                >
                  {opt === "metric" ? "Metric (kg / cm)" : "Imperial (lbs / in)"}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="profile-weight" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
                Weight ({units === "imperial" ? "lbs" : "kg"})
              </label>
              <input
                id="profile-weight"
                type="text"
                inputMode="decimal"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                className="w-full border border-neutral-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
              />
            </div>
            <div>
              <label htmlFor="profile-goal-weight" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
                Goal weight ({units === "imperial" ? "lbs" : "kg"})
              </label>
              <input
                id="profile-goal-weight"
                type="text"
                inputMode="decimal"
                value={goalWeight}
                onChange={(e) => setGoalWeight(e.target.value)}
                className="w-full border border-neutral-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
              />
            </div>
          </div>

          <div>
            <label htmlFor="profile-height" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
              Height ({units === "imperial" ? "in" : "cm"})
            </label>
            <input
              id="profile-height"
              type="text"
              inputMode="decimal"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              className="w-full border border-neutral-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
            />
          </div>

          <div>
            <label htmlFor="profile-dob" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
              Date of birth
            </label>
            <input
              id="profile-dob"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="w-full border border-neutral-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
            />
          </div>

          <div>
            <label htmlFor="profile-activity" className="block text-[11px] tracking-[0.15em] font-semibold uppercase text-neutral-500 mb-2">
              Activity level
            </label>
            <select
              id="profile-activity"
              value={activityLevel}
              onChange={(e) => setActivityLevel(e.target.value)}
              className="w-full border border-neutral-300 px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
            >
              <option value="">Not set</option>
              {ACTIVITY_LEVELS.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </div>

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full bg-neutral-900 text-white text-sm font-medium py-3 hover:bg-neutral-800 transition-colors disabled:opacity-60"
          >
            {saving ? "Saving…" : saved ? "Saved" : "Save changes"}
          </button>
        </form>
      </div>
    </div>
  );
}

function TrainingLog({ session, onLogout }) {
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0]);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const [builderOpen, setBuilderOpen] = useState(false);
  const [workoutEntries, setWorkoutEntries] = useState([]);
  // Whichever day is currently open in the builder — today by default, or a
  // past day the client clicked into from history to amend it.
  const [openWorkoutId, setOpenWorkoutId] = useState(null);
  const [openWorkoutStatus, setOpenWorkoutStatus] = useState(null);
  const [openWorkoutDate, setOpenWorkoutDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);

  const [search, setSearch] = useState("");
  const [viewingExercise, setViewingExercise] = useState(null);

  const [profile, setProfile] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);

  const {
    restActive, restRemaining, restLabel, restPaused,
    startRestTimer, adjustRestTimer, pauseResumeRestTimer, skipRestTimer,
  } = useRestTimer();

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=eq.${session.user.id}&select=weight_kg,height_cm,goal_weight_kg,date_of_birth,activity_level,measurement_system`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
        );
        if (!res.ok) return;
        const rows = await res.json();
        if (rows[0]) setProfile(rows[0]);
      } catch {
        // Weight-unit label just falls back to kg; the profile modal will
        // still show its own error if this keeps failing.
      }
    })();
  }, []);

  // One consolidated workout row per client per day — load today's (if any)
  // to pre-fill the builder for editing/completing, and the rest of the
  // history (past days only) as a separate list below it.
  useEffect(() => {
    loadToday();
    loadHistory();
  }, []);

  async function loadToday() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/workouts?client_id=eq.${session.user.id}&workout_date=eq.${today}&select=id,status,entries&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
      );
      if (!res.ok) return;
      const rows = await res.json();
      if (rows[0]) {
        setOpenWorkoutId(rows[0].id);
        setOpenWorkoutStatus(rows[0].status);
        setOpenWorkoutDate(today);
        setWorkoutEntries((rows[0].entries || []).map(hydrateExerciseEntry));
        setBuilderOpen(true);
      }
    } catch {
      // Worst case a coach-assigned session for today just doesn't pre-load
      // — the client can still build a fresh workout from scratch.
    }
  }

  // Open a past day from history into the builder so it can be amended —
  // reuses the same add/update/remove/save logic as "today".
  function openHistoryDay(w) {
    setOpenWorkoutId(w.id);
    setOpenWorkoutStatus(w.status);
    setOpenWorkoutDate(w.workout_date);
    setWorkoutEntries((w.entries || []).map(hydrateExerciseEntry));
    setSaveError("");
    setBuilderOpen(true);
  }

  function backToToday() {
    setBuilderOpen(false);
    setWorkoutEntries([]);
    setSaveError("");
    loadToday();
  }

  async function deleteWorkoutDay(id) {
    setDeletingId(id);
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/workouts?id=eq.${id}`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error("Could not delete this workout.");
      setDeleteConfirmId(null);
      if (id === openWorkoutId) {
        setOpenWorkoutId(null);
        setOpenWorkoutStatus(null);
        setOpenWorkoutDate(new Date().toISOString().slice(0, 10));
        setWorkoutEntries([]);
        setBuilderOpen(false);
      }
      loadHistory();
    } catch (err) {
      setHistoryError(err.message || "Could not delete this workout.");
    } finally {
      setDeletingId(null);
    }
  }

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/workouts?client_id=eq.${session.user.id}&workout_date=lt.${today}&select=id,workout_date,status,entries,category&order=workout_date.desc&limit=10`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
      );
      if (!res.ok) throw new Error("Could not load your workout history.");
      setHistory(await res.json());
    } catch (err) {
      setHistory([]);
      setHistoryError(err.message || "Could not load your workout history.");
    } finally {
      setHistoryLoading(false);
    }
  }

  function addExerciseToWorkout(name) {
    const isTimeBased = activeCategory === "Sprint Interval Training";
    setWorkoutEntries((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        exercise: name,
        category: activeCategory,
        restMinutes: isTimeBased ? "3" : "1",
        sets: [
          {
            id: crypto.randomUUID(),
            weight: "",
            reps: isTimeBased ? "" : "5",
            time: isTimeBased ? "20" : "",
            rpe: "",
            type: "normal",
            completed: false,
            completedAt: null,
          },
        ],
      },
    ]);
    setBuilderOpen(true);
  }

  function addSet(groupId) {
    setWorkoutEntries((prev) =>
      prev.map((g) => (g.id !== groupId ? g : { ...g, sets: [...g.sets, newSet(g.sets[g.sets.length - 1])] }))
    );
  }

  function updateGroupField(groupId, field, value) {
    setWorkoutEntries((prev) => prev.map((g) => (g.id === groupId ? { ...g, [field]: value } : g)));
  }

  function updateSet(groupId, setId, field, value) {
    setWorkoutEntries((prev) =>
      prev.map((g) =>
        g.id !== groupId ? g : { ...g, sets: g.sets.map((s) => (s.id === setId ? { ...s, [field]: value } : s)) }
      )
    );
  }

  function removeSet(groupId, setId) {
    setWorkoutEntries((prev) =>
      prev.map((g) => (g.id !== groupId ? g : { ...g, sets: g.sets.filter((s) => s.id !== setId) }))
    );
  }

  function removeExerciseGroup(groupId) {
    setWorkoutEntries((prev) => prev.filter((g) => g.id !== groupId));
  }

  // Checking a set complete starts the rest timer for that exercise's
  // configured rest — unchecking it just clears the completion state.
  function toggleSetComplete(groupId, setId) {
    const group = workoutEntries.find((g) => g.id === groupId);
    const set = group?.sets.find((s) => s.id === setId);
    if (!group || !set) return;
    const nowCompleted = !set.completed;
    setWorkoutEntries((prev) =>
      prev.map((g) =>
        g.id !== groupId
          ? g
          : {
              ...g,
              sets: g.sets.map((s) =>
                s.id !== setId
                  ? s
                  : { ...s, completed: nowCompleted, completedAt: nowCompleted ? new Date().toISOString() : null }
              ),
            }
      )
    );
    if (nowCompleted) {
      const restSeconds = Math.round((Number(group.restMinutes) || 0) * 60);
      if (restSeconds > 0) startRestTimer(restSeconds, group.exercise);
    }
  }

  async function saveWorkout() {
    if (workoutEntries.length === 0) {
      setSaveError("Add at least one exercise before saving.");
      return;
    }
    for (const group of workoutEntries) {
      if (group.sets.length === 0) {
        setSaveError(`Add at least one set for ${group.exercise}, or remove it.`);
        return;
      }
      if (group.restMinutes.trim() !== "" && !(Number(group.restMinutes) >= 0)) {
        setSaveError(`Enter a valid rest time for ${group.exercise}, or leave it blank.`);
        return;
      }
      for (const s of group.sets) {
        if (group.category === "Sprint Interval Training") {
          const time = Number(s.time);
          if (!Number.isInteger(time) || time <= 0) {
            setSaveError(`Enter a valid sprint time for every set of ${group.exercise}.`);
            return;
          }
        } else {
          const reps = Number(s.reps);
          const allowZero = s.type === "failure";
          if (!Number.isInteger(reps) || (allowZero ? reps < 0 : reps <= 0)) {
            setSaveError(`Enter a valid number of reps for every set of ${group.exercise}.`);
            return;
          }
        }
        if (s.weight.trim() !== "" && !(Number(s.weight) >= 0)) {
          setSaveError(`Enter a valid weight for ${group.exercise}, or leave it blank.`);
          return;
        }
        if (s.rpe.trim() !== "") {
          const rpeNum = Number(s.rpe);
          if (!(rpeNum >= 6 && rpeNum <= 10) || Math.round(rpeNum * 2) !== rpeNum * 2) {
            setSaveError(`RPE must be between 6 and 10 in 0.5 steps for ${group.exercise}, or left blank.`);
            return;
          }
        }
      }
    }
    setSaving(true);
    setSaveError("");
    try {
      const body = {
        entries: workoutEntries.map(({ id, sets, ...rest }) => ({
          ...rest,
          sets: sets.map(({ id, ...s }) => s),
        })),
        status: "completed",
      };
      const res = openWorkoutId
        ? await fetch(`${SUPABASE_URL}/rest/v1/workouts?id=eq.${openWorkoutId}`, {
            method: "PATCH",
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${session.access_token}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify(body),
          })
        : await fetch(`${SUPABASE_URL}/rest/v1/workouts`, {
            method: "POST",
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${session.access_token}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({
              client_id: session.user.id,
              workout_date: openWorkoutDate,
              ...body,
            }),
          });
      if (res.status === 401 || res.status === 403) {
        throw new Error("Your session may have expired. Try logging out and back in.");
      }
      if (!res.ok) throw new Error("Could not save workout.");
      const rows = await res.json();
      if (rows[0]) {
        setOpenWorkoutId(rows[0].id);
        setOpenWorkoutStatus(rows[0].status);
      }
      // A day other than today was just amended — refresh the history list
      // so its summary/status reflects the change.
      if (openWorkoutDate !== new Date().toISOString().slice(0, 10)) loadHistory();
    } catch (err) {
      setSaveError(err.message || "Something went wrong saving this workout.");
    } finally {
      setSaving(false);
    }
  }

  const filteredLibrary = useMemo(() => {
    const q = search.trim().toLowerCase();
    return EXERCISE_LIBRARY.filter((ex) => {
      const inCategory = (EXERCISE_CATEGORIES[ex] || []).includes(activeCategory);
      const matchesSearch = !q || ex.toLowerCase().includes(q);
      return inCategory && matchesSearch;
    });
  }, [search, activeCategory]);

  const unitLabel = profile?.measurement_system === "imperial" ? "lbs" : "kg";

  return (
    <div className="min-h-screen bg-[#F5F4F1] px-5 sm:px-10 py-8 sm:py-12">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-2">
              Client workspace
            </p>
            <h1 className="font-black leading-[0.95] text-5xl sm:text-6xl tracking-tight text-neutral-900">
              Training
              <br />
              Log
            </h1>
          </div>
          <div className="flex items-center gap-4 shrink-0 mt-1">
            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900"
            >
              <User size={14} /> Profile
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900"
            >
              <LogOut size={14} /> Log out
            </button>
          </div>
        </div>

        {profileOpen && (
          profile ? (
            <ProfileModal
              session={session}
              profile={profile}
              onClose={() => setProfileOpen(false)}
              onSaved={(updated) => setProfile(updated)}
            />
          ) : (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
              <p className="text-sm text-white">Loading…</p>
            </div>
          )
        )}

        <div className="mt-8 border-b border-neutral-300" />

        <div role="tablist" className="mt-6 flex flex-wrap gap-3">
          {CATEGORIES.map((cat) => {
            const active = cat === activeCategory;
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveCategory(cat)}
                className={`px-5 py-4 text-sm font-medium border transition-colors text-left min-w-[140px] flex-1 sm:flex-none ${
                  active
                    ? "bg-neutral-900 text-white border-neutral-900"
                    : "bg-white text-neutral-700 border-neutral-200 hover:border-neutral-400"
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>

        <div className="mt-10 border-b border-neutral-300" />

        <div className="mt-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-1">
              {new Date(`${openWorkoutDate}T00:00:00`).toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </p>
            <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-neutral-900">
              {openWorkoutDate === new Date().toISOString().slice(0, 10) ? "Today's workout." : "Amending this day."}
            </h2>
            {openWorkoutDate !== new Date().toISOString().slice(0, 10) && (
              <button
                type="button"
                onClick={backToToday}
                className="mt-1 flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900"
              >
                <ArrowLeft size={12} /> Back to today
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setBuilderOpen((v) => !v)}
            className="shrink-0 flex items-center gap-2 bg-neutral-900 text-white text-sm font-medium px-5 py-3 hover:bg-neutral-800 transition-colors"
          >
            {builderOpen ? "Hide" : "Start Workout"}
            <Play size={14} fill="currentColor" strokeWidth={0} />
          </button>
        </div>

        {restActive && (
          <div className="sticky top-2 z-10 mt-6 bg-neutral-900 text-white px-4 py-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.15em] text-neutral-400">
                Rest{restLabel ? ` — ${restLabel}` : ""}
              </p>
              <p className="text-2xl font-black tabular-nums leading-tight">{formatRestClock(restRemaining)}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => adjustRestTimer(-15)} className="text-xs px-2.5 py-2 border border-neutral-600 hover:border-neutral-400">
                -15
              </button>
              <button type="button" onClick={() => adjustRestTimer(15)} className="text-xs px-2.5 py-2 border border-neutral-600 hover:border-neutral-400">
                +15
              </button>
              <button type="button" onClick={pauseResumeRestTimer} className="text-xs px-2.5 py-2 border border-neutral-600 hover:border-neutral-400">
                {restPaused ? "Resume" : "Pause"}
              </button>
              <button type="button" onClick={skipRestTimer} className="text-xs px-2.5 py-2 border border-neutral-600 hover:border-neutral-400">
                Skip
              </button>
            </div>
          </div>
        )}

        {builderOpen && (
          <div className="mt-6 border border-neutral-200 bg-white p-5">
            {openWorkoutStatus === "assigned" && (
              <p className="mb-4 border border-amber-200 bg-amber-50 text-amber-800 text-sm px-3 py-2.5">
                Your coach assigned this workout. Adjust anything you need, then save when you're done.
              </p>
            )}
            {workoutEntries.length === 0 ? (
              <p className="text-sm text-neutral-500">
                Search the exercise library below (use the category tabs above to browse) and click an exercise to add it here.
              </p>
            ) : (
              <div className="space-y-6">
                {workoutEntries.map((group) => {
                  const isTimeBased = group.category === "Sprint Interval Training";
                  return (
                    <div key={group.id} className="border-b border-neutral-100 pb-5 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                          <span className="text-sm font-semibold text-neutral-900">{group.exercise}</span>
                          <span className="ml-1.5 text-xs text-neutral-400">{abbreviateCategory(group.category)}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="flex items-center gap-1.5">
                            <input
                              type="number"
                              inputMode="decimal"
                              step="0.5"
                              value={group.restMinutes}
                              onChange={(e) => updateGroupField(group.id, "restMinutes", e.target.value)}
                              aria-label={`Rest in minutes for ${group.exercise}`}
                              className="w-14 border border-neutral-300 px-2 py-1.5 text-sm"
                            />
                            <span className="text-xs text-neutral-400">min rest</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => removeExerciseGroup(group.id)}
                            aria-label={`Remove ${group.exercise}`}
                            className="text-neutral-400 hover:text-red-600 p-1"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        {group.sets.map((s, i) => (
                          <div
                            key={s.id}
                            className={`flex flex-wrap items-center gap-2 p-2 border ${
                              s.completed ? "bg-emerald-50 border-emerald-200" : "border-neutral-200"
                            }`}
                          >
                            <span className="w-5 text-xs font-semibold text-neutral-400 text-center shrink-0">{i + 1}</span>
                            <select
                              value={s.type}
                              onChange={(e) => updateSet(group.id, s.id, "type", e.target.value)}
                              aria-label={`Set type for set ${i + 1} of ${group.exercise}`}
                              className={`text-xs border px-1.5 py-2 sm:py-1.5 shrink-0 ${SET_TYPE_STYLES[s.type]}`}
                            >
                              {SET_TYPES.map((t) => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </select>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={s.weight}
                              onChange={(e) => updateSet(group.id, s.id, "weight", e.target.value)}
                              placeholder={`Weight (${unitLabel})`}
                              aria-label={`Weight for set ${i + 1} of ${group.exercise}`}
                              className="w-20 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                            />
                            {isTimeBased ? (
                              <input
                                type="number"
                                inputMode="numeric"
                                value={s.time}
                                onChange={(e) => updateSet(group.id, s.id, "time", e.target.value)}
                                placeholder="Sec"
                                aria-label={`Sprint time for set ${i + 1} of ${group.exercise}`}
                                className="w-16 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                              />
                            ) : (
                              <input
                                type="number"
                                inputMode="numeric"
                                value={s.reps}
                                onChange={(e) => updateSet(group.id, s.id, "reps", e.target.value)}
                                placeholder="Reps"
                                aria-label={`Reps for set ${i + 1} of ${group.exercise}`}
                                className="w-16 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                              />
                            )}
                            <input
                              type="number"
                              inputMode="decimal"
                              step="0.5"
                              min="6"
                              max="10"
                              value={s.rpe}
                              onChange={(e) => updateSet(group.id, s.id, "rpe", e.target.value)}
                              placeholder="RPE"
                              aria-label={`RPE for set ${i + 1} of ${group.exercise}`}
                              className="w-16 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                            />
                            <button
                              type="button"
                              onClick={() => toggleSetComplete(group.id, s.id)}
                              aria-pressed={s.completed}
                              aria-label={
                                s.completed
                                  ? `Mark set ${i + 1} of ${group.exercise} incomplete`
                                  : `Mark set ${i + 1} of ${group.exercise} complete`
                              }
                              className={`ml-auto shrink-0 w-9 h-9 flex items-center justify-center border ${
                                s.completed
                                  ? "bg-emerald-600 border-emerald-600 text-white"
                                  : "border-neutral-300 text-neutral-300 hover:border-neutral-500"
                              }`}
                            >
                              <Check size={16} />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeSet(group.id, s.id)}
                              aria-label={`Remove set ${i + 1} of ${group.exercise}`}
                              className="text-neutral-300 hover:text-red-600 p-1 shrink-0"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={() => addSet(group.id)}
                        className="mt-2 flex items-center gap-1 text-xs font-medium text-neutral-600 hover:text-neutral-900"
                      >
                        <Plus size={12} /> Add set
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {saveError && <p className="mt-3 text-sm text-red-600">{saveError}</p>}

            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                disabled={saving || workoutEntries.length === 0}
                onClick={saveWorkout}
                className="bg-neutral-900 text-white text-sm font-medium px-5 py-2.5 hover:bg-neutral-800 transition-colors disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save workout"}
              </button>
              <span className="text-xs text-neutral-400">
                {workoutEntries.length} exercise{workoutEntries.length === 1 ? "" : "s"},{" "}
                {workoutEntries.reduce((n, g) => n + g.sets.filter((s) => s.completed).length, 0)}/
                {workoutEntries.reduce((n, g) => n + g.sets.length, 0)} sets done
              </span>
            </div>
          </div>
        )}

        <div className="mt-10 border-b border-neutral-300" />

        <div className="mt-6">
          <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-1">
            Exercise history details
          </p>
          {history.length > 0 && !historyLoading && (
            <p className="text-xs text-neutral-400 mb-2">Tap a day to amend it, or use the bin icon to delete it.</p>
          )}
          {historyLoading ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : historyError ? (
            <p className="text-sm text-red-600" role="alert">
              {historyError} If this keeps happening, try logging out and back in.
            </p>
          ) : history.length === 0 ? (
            <p className="text-sm text-neutral-500">Your past workout days will appear here.</p>
          ) : (
            <ul className="divide-y divide-neutral-200 border border-neutral-200 bg-white">
              {history.map((w) => {
                const entries = w.entries || [];
                const cats = [...new Set(entries.map((e) => e.category || w.category).filter(Boolean))];
                return (
                  <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => openHistoryDay(w)}
                      className="flex-1 text-left text-sm text-neutral-800 hover:text-neutral-600"
                    >
                      {cats.map(abbreviateCategory).join(", ") || "Workout"} — {entries.length} exercise{entries.length === 1 ? "" : "s"}
                      {w.status === "assigned" && (
                        <span className="ml-2 text-xs text-amber-600 uppercase tracking-wide">Not completed</span>
                      )}
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-neutral-400">
                        {new Date(w.workout_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                      {deleteConfirmId === w.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => deleteWorkoutDay(w.id)}
                            disabled={deletingId === w.id}
                            className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-60"
                          >
                            {deletingId === w.id ? "Deleting…" : "Confirm"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmId(null)}
                            className="text-xs text-neutral-400 hover:text-neutral-700"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmId(w.id)}
                          aria-label="Delete this workout day"
                          className="text-neutral-300 hover:text-red-600 p-1"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-10 border-b border-neutral-300" />

        <div className="mt-6 pb-16">
          <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-1">
            Exercise library
          </p>
          <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-neutral-900 mb-4">
            Learn each movement.
          </h2>

          <div className="relative mb-3">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Exercise Library"
              aria-label="Search exercise library"
              className="w-full border border-neutral-300 pl-9 pr-9 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-700"
              >
                <X size={15} />
              </button>
            )}
          </div>

          <div className="border border-neutral-200 bg-white max-h-72 overflow-y-auto">
            {filteredLibrary.length === 0 ? (
              <p className="px-4 py-6 text-sm text-neutral-400 text-center">
                No exercises match "{search}".
              </p>
            ) : (
              filteredLibrary.map((ex) => (
                <div
                  key={ex}
                  className="w-full flex items-center justify-between border-b border-neutral-100 last:border-0 hover:bg-neutral-50 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => setViewingExercise(ex)}
                    className="flex-1 text-left px-4 py-2.5 text-sm text-neutral-700"
                  >
                    {ex}
                  </button>
                  <button
                    type="button"
                    onClick={() => addExerciseToWorkout(ex)}
                    aria-label={`Add ${ex} to workout`}
                    className="px-3 py-2.5 text-neutral-300 hover:text-neutral-900"
                  >
                    <Plus size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          {viewingExercise && (
            <ExerciseDetailModal
              name={viewingExercise}
              onClose={() => setViewingExercise(null)}
              onAdd={() => {
                addExerciseToWorkout(viewingExercise);
                setViewingExercise(null);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Coach dashboard — client roster, progress review, assigning
// workouts, and an admin view of subscribers.
// ============================================================
const COACH_TABS = [
  { key: "clients", label: "Clients", icon: Users },
  { key: "admin", label: "Admin", icon: ShieldCheck },
];

function CoachDashboard({ session, onLogout }) {
  const [tab, setTab] = useState("clients");
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsError, setClientsError] = useState("");
  const [selectedClient, setSelectedClient] = useState(null);

  useEffect(() => {
    loadClients();
  }, []);

  async function loadClients() {
    setClientsLoading(true);
    setClientsError("");
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?role=eq.client&select=id,full_name,email,status,measurement_system&order=full_name.asc`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
      );
      if (!res.ok) throw new Error("Could not load your client list.");
      setClients(await res.json());
    } catch (err) {
      setClientsError(err.message || "Could not load your client list.");
    } finally {
      setClientsLoading(false);
    }
  }

  if (selectedClient) {
    return (
      <ClientWorkspace
        client={selectedClient}
        session={session}
        onBack={() => setSelectedClient(null)}
        onLogout={onLogout}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F4F1] px-5 sm:px-10 py-8 sm:py-12">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-2">
              Coach workspace
            </p>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-neutral-900">
              Coach dashboard
            </h1>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 shrink-0 mt-2"
          >
            <LogOut size={14} /> Log out
          </button>
        </div>

        <div role="tablist" className="mt-8 flex items-center gap-6 border-b border-neutral-200">
          {COACH_TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 pb-3 text-sm whitespace-nowrap transition-colors border-b-2 -mb-px ${
                  active
                    ? "border-neutral-900 text-neutral-900 font-medium"
                    : "border-transparent text-neutral-400 hover:text-neutral-600"
                }`}
              >
                <Icon size={14} strokeWidth={2} />
                {label}
              </button>
            );
          })}
        </div>

        {tab === "clients" && (
          <div className="mt-6">
            {clientsLoading ? (
              <p className="text-sm text-neutral-400">Loading…</p>
            ) : clientsError ? (
              <p className="text-sm text-red-600" role="alert">
                {clientsError}
              </p>
            ) : clients.length === 0 ? (
              <p className="text-sm text-neutral-500">No clients have registered yet.</p>
            ) : (
              <ul className="divide-y divide-neutral-200 border border-neutral-200 bg-white">
                {clients.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedClient(c)}
                      className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-neutral-50 transition-colors"
                    >
                      <span>
                        <span className="block text-sm font-medium text-neutral-900">
                          {c.full_name || c.email}
                        </span>
                        <span className="block text-xs text-neutral-400">{c.email}</span>
                      </span>
                      <ArrowUpRight size={16} className="text-neutral-300 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === "admin" && <SubscribersAdmin session={session} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// A single client's progress: workout history plus a builder for
// assigning a new workout, scoped to that client's category tabs.
// ------------------------------------------------------------
function ClientWorkspace({ client, session, onBack, onLogout }) {
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0]);
  const [targetDate, setTargetDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const [builderOpen, setBuilderOpen] = useState(false);
  const [workoutEntries, setWorkoutEntries] = useState([]);
  const [workoutId, setWorkoutId] = useState(null);
  const [workoutStatus, setWorkoutStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [search, setSearch] = useState("");

  useEffect(() => {
    loadHistory();
  }, []);

  // Re-load whichever day is selected so the coach edits that day's actual
  // plan (assigned or already completed) instead of always starting blank.
  useEffect(() => {
    loadDay(targetDate);
  }, [targetDate]);

  async function loadDay(date) {
    setBuilderOpen(false);
    setWorkoutEntries([]);
    setWorkoutId(null);
    setWorkoutStatus(null);
    setSaveError("");
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/workouts?client_id=eq.${client.id}&workout_date=eq.${date}&select=id,status,entries&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
      );
      if (!res.ok) return;
      const rows = await res.json();
      if (rows[0]) {
        setWorkoutId(rows[0].id);
        setWorkoutStatus(rows[0].status);
        setWorkoutEntries((rows[0].entries || []).map((e) => ({ id: crypto.randomUUID(), ...e })));
        setBuilderOpen(true);
      }
    } catch {
      // No existing plan for that day — coach just starts a fresh one.
    }
  }

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/workouts?client_id=eq.${client.id}&select=id,workout_date,status,entries,category&order=workout_date.desc&limit=10`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
      );
      if (!res.ok) throw new Error("Could not load this client's workout history.");
      setHistory(await res.json());
    } catch (err) {
      setHistory([]);
      setHistoryError(err.message || "Could not load this client's workout history.");
    } finally {
      setHistoryLoading(false);
    }
  }

  function addExerciseToWorkout(name) {
    const isTimeBased = activeCategory === "Sprint Interval Training";
    setWorkoutEntries((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        exercise: name,
        category: activeCategory,
        weight: "",
        reps: isTimeBased ? "" : "5",
        time: isTimeBased ? "20" : "",
        rest: isTimeBased ? "3" : "1",
        sets: isTimeBased ? "6" : "3",
      },
    ]);
    setBuilderOpen(true);
  }

  function updateEntry(id, field, value) {
    setWorkoutEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
  }

  function removeEntry(id) {
    setWorkoutEntries((prev) => prev.filter((e) => e.id !== id));
  }

  async function assignWorkout() {
    if (workoutEntries.length === 0) {
      setSaveError("Add at least one exercise before assigning.");
      return;
    }
    for (const entry of workoutEntries) {
      const sets = Number(entry.sets);
      if (!Number.isInteger(sets) || sets <= 0) {
        setSaveError(`Enter a valid number of sets for ${entry.exercise}.`);
        return;
      }
      if (entry.category === "Sprint Interval Training") {
        const time = Number(entry.time);
        if (!Number.isInteger(time) || time <= 0) {
          setSaveError(`Enter a valid sprint time for ${entry.exercise}.`);
          return;
        }
      } else {
        const reps = Number(entry.reps);
        if (!Number.isInteger(reps) || reps <= 0) {
          setSaveError(`Enter a valid number of reps for ${entry.exercise}.`);
          return;
        }
      }
      if (entry.weight.trim() !== "" && !(Number(entry.weight) >= 0)) {
        setSaveError(`Enter a valid weight for ${entry.exercise}, or leave it blank.`);
        return;
      }
      if (entry.rest.trim() !== "" && !(Number(entry.rest) >= 0)) {
        setSaveError(`Enter a valid rest time for ${entry.exercise}, or leave it blank.`);
        return;
      }
    }
    setSaving(true);
    setSaveError("");
    try {
      // Never downgrade a day the client already marked completed back to
      // "assigned" just because a coach edited it — only set assigned when
      // creating a new plan or editing one that's still pending.
      const body = {
        entries: workoutEntries.map(({ id, ...rest }) => rest),
        status: workoutStatus === "completed" ? "completed" : "assigned",
        assigned_by: session.user.id,
      };
      const res = workoutId
        ? await fetch(`${SUPABASE_URL}/rest/v1/workouts?id=eq.${workoutId}`, {
            method: "PATCH",
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${session.access_token}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify(body),
          })
        : await fetch(`${SUPABASE_URL}/rest/v1/workouts`, {
            method: "POST",
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${session.access_token}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({ client_id: client.id, workout_date: targetDate, ...body }),
          });
      if (res.status === 401 || res.status === 403) {
        throw new Error("Your session may have expired. Try logging out and back in.");
      }
      if (!res.ok) throw new Error("Could not assign this workout.");
      const rows = await res.json();
      if (rows[0]) {
        setWorkoutId(rows[0].id);
        setWorkoutStatus(rows[0].status);
      }
      loadHistory();
    } catch (err) {
      setSaveError(err.message || "Something went wrong assigning this workout.");
    } finally {
      setSaving(false);
    }
  }

  const filteredLibrary = useMemo(() => {
    const q = search.trim().toLowerCase();
    return EXERCISE_LIBRARY.filter((ex) => {
      const inCategory = (EXERCISE_CATEGORIES[ex] || []).includes(activeCategory);
      const matchesSearch = !q || ex.toLowerCase().includes(q);
      return inCategory && matchesSearch;
    });
  }, [search, activeCategory]);

  const unitLabel = client.measurement_system === "imperial" ? "lbs" : "kg";

  return (
    <div className="min-h-screen bg-[#F5F4F1] px-5 sm:px-10 py-8 sm:py-12">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 mb-3"
            >
              <ArrowLeft size={14} /> Back to clients
            </button>
            <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-2">
              Client progress
            </p>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-neutral-900">
              {client.full_name || client.email}
            </h1>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 shrink-0 mt-2"
          >
            <LogOut size={14} /> Log out
          </button>
        </div>

        <div className="mt-8 border-b border-neutral-300" />

        <div role="tablist" className="mt-6 flex flex-wrap gap-3">
          {CATEGORIES.map((cat) => {
            const active = cat === activeCategory;
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveCategory(cat)}
                className={`px-5 py-4 text-sm font-medium border transition-colors text-left min-w-[140px] flex-1 sm:flex-none ${
                  active
                    ? "bg-neutral-900 text-white border-neutral-900"
                    : "bg-white text-neutral-700 border-neutral-200 hover:border-neutral-400"
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>

        <div className="mt-8 border border-neutral-200 bg-white p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-bold text-neutral-900">Assign a workout</h2>
              {workoutStatus && (
                <span
                  className={`text-xs font-medium uppercase tracking-wide ${
                    workoutStatus === "completed" ? "text-emerald-700" : "text-amber-600"
                  }`}
                >
                  {workoutStatus === "completed" ? "Completed by client" : "Assigned, not yet done"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <input
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                aria-label="Workout date"
                className="border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
              />
              {!builderOpen && (
                <button
                  type="button"
                  onClick={() => setBuilderOpen(true)}
                  className="flex items-center gap-1.5 text-sm font-medium bg-neutral-900 text-white px-4 py-2.5 hover:bg-neutral-800 transition-colors"
                >
                  <Plus size={14} /> Assign workout
                </button>
              )}
            </div>
          </div>

          {builderOpen && (
            <div className="mt-4">
              <p className="text-xs text-neutral-400 mb-3">
                {client.full_name || client.email} tracks weight in {unitLabel}. Use the category tabs above to browse exercises to add.
              </p>
              <WeightConverter />

              {workoutEntries.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  Search the exercise library below and click an exercise to add it here.
                </p>
              ) : (
                <div className="space-y-3">
                  {workoutEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-center gap-2 sm:gap-3 border-b border-neutral-100 pb-3 last:border-0 last:pb-0"
                    >
                      <span className="text-sm font-medium text-neutral-900 w-full sm:w-auto sm:min-w-[140px]">
                        {entry.exercise}
                        <span className="block sm:inline sm:ml-1.5 text-xs font-normal text-neutral-400">
                          {abbreviateCategory(entry.category)}
                        </span>
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={entry.weight}
                        onChange={(e) => updateEntry(entry.id, "weight", e.target.value)}
                        placeholder={`Weight (${unitLabel})`}
                        aria-label={`Weight in ${unitLabel === "lbs" ? "pounds" : "kilograms"} for ${entry.exercise}`}
                        className="w-24 sm:w-28 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                      />
                      {entry.category === "Sprint Interval Training" ? (
                        <span className="flex items-center gap-1.5 shrink-0">
                          <input
                            type="number"
                            inputMode="numeric"
                            value={entry.time}
                            onChange={(e) => updateEntry(entry.id, "time", e.target.value)}
                            placeholder="Time"
                            aria-label={`Sprint time in seconds for ${entry.exercise}`}
                            className="w-16 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                          />
                          <span className="text-xs text-neutral-400">sec sprint</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 shrink-0">
                          <input
                            type="number"
                            inputMode="numeric"
                            value={entry.reps}
                            onChange={(e) => updateEntry(entry.id, "reps", e.target.value)}
                            placeholder="Reps"
                            aria-label={`Reps for ${entry.exercise}`}
                            className="w-16 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                          />
                          <span className="text-xs text-neutral-400">reps</span>
                        </span>
                      )}
                      <span className="flex items-center gap-1.5 shrink-0">
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.5"
                          value={entry.rest}
                          onChange={(e) => updateEntry(entry.id, "rest", e.target.value)}
                          placeholder="Rest"
                          aria-label={`Rest in minutes for ${entry.exercise}`}
                          className="w-16 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                        />
                        <span className="text-xs text-neutral-400">min rest</span>
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={entry.sets}
                          onChange={(e) => updateEntry(entry.id, "sets", e.target.value)}
                          placeholder="Sets"
                          aria-label={`Sets for ${entry.exercise}`}
                          className="w-16 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                        />
                        <span className="text-xs text-neutral-400">sets</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => removeEntry(entry.id)}
                        className="ml-auto text-neutral-400 hover:text-red-600 p-1"
                        aria-label="Remove exercise"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="relative mt-4 mb-3">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search Exercise Library"
                  aria-label="Search exercise library"
                  className="w-full border border-neutral-300 pl-9 pr-9 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-700"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>

              <div className="max-h-56 overflow-y-auto border border-neutral-200">
                {filteredLibrary.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-neutral-400">No exercises match "{search}".</p>
                ) : (
                  filteredLibrary.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => addExerciseToWorkout(ex)}
                      className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-left text-neutral-700 border-b border-neutral-100 last:border-0 hover:bg-neutral-50 transition-colors"
                    >
                      {ex}
                      <Plus size={14} className="text-neutral-300" />
                    </button>
                  ))
                )}
              </div>

              {saveError && (
                <p className="mt-3 text-sm text-red-600" role="alert">
                  {saveError}
                </p>
              )}

              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  disabled={saving || workoutEntries.length === 0}
                  onClick={assignWorkout}
                  className="flex-1 sm:flex-none bg-neutral-900 text-white text-sm font-medium px-5 py-3 hover:bg-neutral-800 transition-colors disabled:opacity-50"
                >
                  {saving ? "Assigning…" : "Assign workout"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBuilderOpen(false);
                    setWorkoutEntries([]);
                    setSaveError("");
                  }}
                  className="text-sm text-neutral-500 hover:text-neutral-900"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="mt-6 border-t border-neutral-100 pt-5">
            <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-2">
              History
            </p>
            {historyLoading ? (
              <p className="text-sm text-neutral-400">Loading…</p>
            ) : historyError ? (
              <p className="text-sm text-red-600" role="alert">
                {historyError}
              </p>
            ) : history.length === 0 ? (
              <p className="text-sm text-neutral-500">No workouts logged yet.</p>
            ) : (
              <ul className="divide-y divide-neutral-200 border border-neutral-200 bg-white">
                {history.map((w) => {
                  const entries = w.entries || [];
                  const cats = [...new Set(entries.map((e) => e.category || w.category).filter(Boolean))];
                  return (
                    <li key={w.id} className="flex items-center justify-between px-4 py-3">
                      <span className="text-sm text-neutral-800">
                        {cats.map(abbreviateCategory).join(", ") || "Workout"} — {entries.length} exercise{entries.length === 1 ? "" : "s"}
                        <span
                          className={`ml-2 text-xs font-medium uppercase tracking-wide ${
                            w.status === "completed" ? "text-emerald-700" : "text-amber-600"
                          }`}
                        >
                          {w.status === "completed" ? "Completed" : "Assigned"}
                        </span>
                      </span>
                      <span className="text-xs text-neutral-400">
                        {new Date(w.workout_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Admin: read-only view of current subscribers, pulled straight
// from the subscribers table (populated by the Stripe integration).
// ------------------------------------------------------------
function SubscribersAdmin({ session }) {
  const [subscribers, setSubscribers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/subscribers?select=email,subscribed,subscription_tier,subscription_end&order=email.asc`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
        );
        if (!res.ok) throw new Error("Could not load subscribers.");
        setSubscribers(await res.json());
      } catch (err) {
        setError(err.message || "Could not load subscribers.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="mt-6">
      <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-2">
        Current subscribers
      </p>
      {loading ? (
        <p className="text-sm text-neutral-400">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : subscribers.length === 0 ? (
        <p className="text-sm text-neutral-500">No subscribers yet.</p>
      ) : (
        <div className="overflow-x-auto border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 uppercase tracking-wide">
                <th className="px-4 py-3 font-semibold">Email</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Plan</th>
                <th className="px-4 py-3 font-semibold">Renews / ends</th>
              </tr>
            </thead>
            <tbody>
              {subscribers.map((s) => (
                <tr key={s.email} className="border-b border-neutral-100 last:border-0">
                  <td className="px-4 py-3 text-neutral-800">{s.email}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs font-medium uppercase tracking-wide ${
                        s.subscribed ? "text-emerald-700" : "text-neutral-400"
                      }`}
                    >
                      {s.subscribed ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{s.subscription_tier || "—"}</td>
                  <td className="px-4 py-3 text-neutral-600">
                    {s.subscription_end ? new Date(s.subscription_end).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
