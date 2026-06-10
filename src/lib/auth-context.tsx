import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session, User } from "@supabase/supabase-js";

export type Profile = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "operator" | "viewer";
  is_active: boolean;
};

type AuthCtx = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  isAdmin: boolean;
  isViewer: boolean;
  canWrite: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const loadedProfileFor = useRef<string | null>(null);

  const loadProfile = async (userId: string) => {
    if (loadedProfileFor.current === userId) return;
    loadedProfileFor.current = userId;
    const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    setProfile((data as Profile | null) ?? null);
  };

  useEffect(() => {
    let mounted = true;

    // Subscribe first — synchronous handler, defer async work.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!mounted) return;
      // Ignore noisy events that should not change auth state.
      if (event === "TOKEN_REFRESHED") {
        setSession(s);
        return;
      }
      if (event === "SIGNED_OUT") {
        loadedProfileFor.current = null;
        setSession(null);
        setProfile(null);
        return;
      }
      if (event === "SIGNED_IN" || event === "USER_UPDATED" || event === "INITIAL_SESSION") {
        setSession(s);
        if (s?.user) setTimeout(() => loadProfile(s.user.id), 0);
        else setProfile(null);
      }
    });

    // Then hydrate existing session.
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      if (data.session?.user) {
        loadProfile(data.session.user.id).finally(() => mounted && setLoading(false));
      } else {
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return (
    <Ctx.Provider
      value={{
        session,
        user: session?.user ?? null,
        profile,
        loading,
        isAdmin: profile?.role === "admin",
        isViewer: profile?.role === "viewer",
        canWrite: profile?.role === "admin" || profile?.role === "operator",
        signOut: async () => { await supabase.auth.signOut(); },
        refreshProfile: async () => {
          if (session?.user) {
            loadedProfileFor.current = null;
            await loadProfile(session.user.id);
          }
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be inside AuthProvider");
  return c;
}
