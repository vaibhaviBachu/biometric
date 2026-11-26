import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import {
  AuthUser, getAccessToken, parseJwt, clearTokens,
  apiLogout, refreshAccessToken, applyFaceAuthTokens, apiFetchMe,
  hasValidAccessToken, subscribeAuthEvents, lastRefreshWasUnavailable,
} from '../lib/auth';
import { purgeLegacyAccountStorage } from '../lib/legacy-account-storage';
import { clearPageCache } from '../lib/page-cache';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  loginWithFaceResponse: (data: { accessToken?: string; refreshToken?: string }) => void;
  logout: () => Promise<void>;
  /** Drop leftover JWT/local user without a server round-trip — used at biometric login/register start. */
  resetLocalSession: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function userFromToken(token: string | null): AuthUser | null {
  if (!token || !hasValidAccessToken(token)) return null;
  return parseJwt(token);
}

/** Attempts and waits while the API is waking or briefly unreachable (Render cold start, redeploy). */
const BOOT_REFRESH_RETRY_MS = [1500, 3000, 5000];

/**
 * Renew the session on page load. Only a refusal from the server ends it; when the server could not be reached,
 * wait and try again rather than treating a sleeping backend as a signed-out user.
 */
async function refreshOnBoot(isCancelled: () => boolean): Promise<string | null> {
  let token = await refreshAccessToken();
  for (const wait of BOOT_REFRESH_RETRY_MS) {
    if (token || !lastRefreshWasUnavailable() || isCancelled()) break;
    await new Promise((r) => setTimeout(r, wait));
    token = await refreshAccessToken();
  }
  return token;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]       = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        let token = getAccessToken();
        if (!hasValidAccessToken(token)) {
          token = await refreshOnBoot(() => cancelled);
        }

        if (!hasValidAccessToken(token)) {
          if (!cancelled) setUser(null);
          return;
        }

        try {
          const me = await apiFetchMe();
          if (cancelled) return;
          if (me) {
            setUser(me);
            return;
          }
        } catch (e: unknown) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const status = (e as any)?.response?.status as number | undefined;
          if (!status) {
            // Network / backend waking: keep a locally valid JWT rather than bounce to login.
            const parsed = userFromToken(token);
            if (!cancelled && parsed) {
              setUser(parsed);
            }
            return;
          }
          if (status === 401) {
            const next = await refreshOnBoot(() => cancelled);
            if (next) {
              try {
                const me = await apiFetchMe();
                if (!cancelled && me) {
                  setUser(me);
                  return;
                }
              } catch { /* fall through */ }
              const parsed = userFromToken(next);
              if (!cancelled && parsed) {
                setUser(parsed);
                return;
              }
            }
            if (!cancelled) {
              clearTokens();
              setUser(null);
            }
            return;
          }
        }

        const parsed = userFromToken(token);
        if (!cancelled && parsed) {
          setUser(parsed);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    purgeLegacyAccountStorage();
    void bootstrap();
    return () => { cancelled = true; };
  }, []);

  // Cached page data belongs to one user: empty it whenever the signed-in user changes or signs out.
  useEffect(() => {
    clearPageCache();
  }, [user?.sub]);

  useEffect(() => {
    return subscribeAuthEvents((type) => {
      if (type === 'logout') {
        clearTokens();
        setUser(null);
        return;
      }
      const parsed = userFromToken(getAccessToken());
      if (parsed) setUser(parsed);
    });
  }, []);

  function loginWithFaceResponse(data: { accessToken?: string; refreshToken?: string }) {
    const u = applyFaceAuthTokens(data);
    if (u) {
      setUser(u);
    } else if (data.accessToken) {
      const parsed = parseJwt(data.accessToken);
      if (parsed) {
        setUser(parsed);
      }
    }
  }

  const resetLocalSession = useCallback(() => {
    clearTokens();
    setUser(null);
  }, []);

  async function logout() {
    await apiLogout();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, loginWithFaceResponse, logout, resetLocalSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
