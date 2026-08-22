import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  User, UserPlus, ClipboardList, ArrowUpRight, Clock, XCircle,
  Play, Search, X, Plus, Trash2, LogOut,
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
export default function StudioDefineApp() {
  const [screen, setScreen] = useState("auth"); // auth | client-dashboard | coach-dashboard
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);

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
  const [screen, setScreen] = useState("form"); // form | pending | rejected | check-email

  const isRegisterTab = activeTab === "client-register" || activeTab === "coach-register";
  const isCoachTab = activeTab === "coach-login" || activeTab === "coach-register";

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

const EXERCISE_LIBRARY = [
  "Arnold Press", "Back Extension", "Back Squat", "Barbell Row", "Battle Ropes",
  "Bench Press", "Bent-Over Row", "Biceps Curl", "Box Jump", "Bulgarian Split Squat",
  "Burpee", "Cable Crossover", "Cable Row", "Calf Raise", "Chest Fly",
  "Chin-Up", "Clean and Jerk", "Close-Grip Bench Press", "Concentration Curl", "Deadlift",
  "Deficit Deadlift", "Dumbbell Press", "Dumbbell Row", "Face Pull", "Farmer's Carry",
  "Front Squat", "Glute Bridge", "Goblet Squat", "Hack Squat", "Hammer Curl",
  "Hanging Leg Raise", "Hip Thrust", "Incline Bench Press", "Jump Rope", "Jump Squat",
  "Kettlebell Swing", "Lat Pulldown", "Lateral Raise", "Leg Curl", "Leg Extension",
  "Leg Press", "Lunges", "Mountain Climbers", "Overhead Press", "Pistol Squat",
  "Plank", "Plyo Push-Up", "Pull-Up", "Push Press", "Push-Up",
  "Renegade Row", "Reverse Lunge", "Romanian Deadlift", "Rowing Sprint", "Russian Twist",
  "Seated Row", "Shoulder Press", "Shrugs", "Side Plank", "Skater Jump",
  "Sled Push", "Snatch", "Sprint (Track)", "Squat Jump", "Standing Calf Raise",
  "Step-Up", "Sumo Deadlift", "T-Bar Row", "Thruster", "Tricep Dip",
  "Tricep Pushdown", "Turkish Get-Up", "Upright Row", "Wall Ball", "Wall Sit",
];

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

function TrainingLog({ session, onLogout }) {
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0]);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const [builderOpen, setBuilderOpen] = useState(false);
  const [workoutEntries, setWorkoutEntries] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [search, setSearch] = useState("");

  // Guards against a slow, stale request overwriting newer results if the
  // user switches categories again before the first fetch resolves.
  const activeCategoryRef = useRef(activeCategory);
  useEffect(() => {
    activeCategoryRef.current = activeCategory;
  }, [activeCategory]);

  useEffect(() => {
    loadHistory(activeCategory);
    setBuilderOpen(false);
    setWorkoutEntries([]);
    setSaveError("");
  }, [activeCategory]);

  async function loadHistory(category) {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/workouts?client_id=eq.${session.user.id}&category=eq.${encodeURIComponent(
          category
        )}&select=id,title,created_at&order=created_at.desc&limit=10`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      );
      if (category !== activeCategoryRef.current) return;
      if (!res.ok) throw new Error("Could not load your workout history.");
      setHistory(await res.json());
    } catch (err) {
      if (category !== activeCategoryRef.current) return;
      setHistory([]);
      setHistoryError(err.message || "Could not load your workout history.");
    } finally {
      if (category === activeCategoryRef.current) setHistoryLoading(false);
    }
  }

  function addExerciseToWorkout(name) {
    setWorkoutEntries((prev) => [
      ...prev,
      { id: crypto.randomUUID(), exercise: name, sets: "3", reps: "10", weight: "" },
    ]);
    setBuilderOpen(true);
  }

  function updateEntry(id, field, value) {
    setWorkoutEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
  }

  function removeEntry(id) {
    setWorkoutEntries((prev) => prev.filter((e) => e.id !== id));
  }

  async function saveWorkout() {
    if (workoutEntries.length === 0) {
      setSaveError("Add at least one exercise before saving.");
      return;
    }
    for (const entry of workoutEntries) {
      const sets = Number(entry.sets);
      const reps = Number(entry.reps);
      if (!Number.isInteger(sets) || sets <= 0) {
        setSaveError(`Enter a valid number of sets for ${entry.exercise}.`);
        return;
      }
      if (!Number.isInteger(reps) || reps <= 0) {
        setSaveError(`Enter a valid number of reps for ${entry.exercise}.`);
        return;
      }
      if (entry.weight.trim() !== "" && !(Number(entry.weight) >= 0)) {
        setSaveError(`Enter a valid weight for ${entry.exercise}, or leave it blank.`);
        return;
      }
    }
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/workouts`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          client_id: session.user.id,
          category: activeCategory,
          title: `${activeCategory} — ${workoutEntries.length} exercise${workoutEntries.length === 1 ? "" : "s"}`,
          entries: workoutEntries.map(({ id, ...rest }) => rest),
        }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error("Your session may have expired. Try logging out and back in.");
      }
      if (!res.ok) throw new Error("Could not save workout.");
      setWorkoutEntries([]);
      setBuilderOpen(false);
      loadHistory(activeCategory);
    } catch (err) {
      setSaveError(err.message || "Something went wrong saving this workout.");
    } finally {
      setSaving(false);
    }
  }

  const filteredLibrary = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return EXERCISE_LIBRARY;
    return EXERCISE_LIBRARY.filter((ex) => ex.toLowerCase().includes(q));
  }, [search]);

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
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 shrink-0 mt-1"
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

        <div className="mt-10 border-b border-neutral-300" />

        <div className="mt-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-1">
              {activeCategory}
            </p>
            <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-neutral-900">
              Build your workout.
            </h2>
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

        {builderOpen && (
          <div className="mt-6 border border-neutral-200 bg-white p-5">
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
                    </span>
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
                    <input
                      type="text"
                      inputMode="decimal"
                      value={entry.weight}
                      onChange={(e) => updateEntry(entry.id, "weight", e.target.value)}
                      placeholder="Weight (kg)"
                      aria-label={`Weight in kilograms for ${entry.exercise}`}
                      className="w-24 sm:w-28 border border-neutral-300 px-2 py-2 sm:py-1.5 text-base sm:text-sm"
                    />
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
                {workoutEntries.length} exercise{workoutEntries.length === 1 ? "" : "s"} added
              </span>
            </div>
          </div>
        )}

        <div className="mt-10 border-b border-neutral-300" />

        <div className="mt-6">
          <p className="text-[10px] sm:text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-2">
            Exercise history details
          </p>
          {historyLoading ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : historyError ? (
            <p className="text-sm text-red-600" role="alert">
              {historyError} If this keeps happening, try logging out and back in.
            </p>
          ) : history.length === 0 ? (
            <p className="text-sm text-neutral-500">Saved workout titles and times will appear here.</p>
          ) : (
            <ul className="divide-y divide-neutral-200 border border-neutral-200 bg-white">
              {history.map((w) => (
                <li key={w.id} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-neutral-800">{w.title}</span>
                  <span className="text-xs text-neutral-400">{timeAgo(w.created_at)}</span>
                </li>
              ))}
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
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Coach dashboard — placeholder until we build this out
// ============================================================
function CoachDashboard({ onLogout }) {
  return (
    <div className="min-h-screen bg-[#F5F4F1] flex items-center justify-center px-6">
      <div className="text-center max-w-sm">
        <p className="text-[11px] tracking-[0.2em] font-semibold uppercase text-neutral-500 mb-3">
          Coach workspace
        </p>
        <h2 className="text-3xl font-black text-neutral-900">Coach dashboard</h2>
        <p className="mt-2 text-sm text-neutral-500">
          This is next up — client rosters, assigning workouts, and progress
          review. Tell Claude what you want here and it'll get built the same
          way as the training log.
        </p>
        <button
          type="button"
          onClick={onLogout}
          className="mt-6 flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 mx-auto"
        >
          <LogOut size={14} /> Log out
        </button>
      </div>
    </div>
  );
}
