import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ScanFace } from 'lucide-react';

import { AuthShell } from '../../components/auth/AuthShell';
import { FaceRoundScan } from '../../components/auth/FaceRoundScan';
import { useAuth } from '../../context/AuthContext';
import {
  getTrustScore, recordLogin, forgetRememberedAccount, LOGIN_CLAIM_PREFILL_KEY,
  saveRegistration, generateHoid, getStoredShortId, getLastAccount, rememberLastAccount,
} from '../../lib/hoid';
import { warmBackend, parseJwt, getAccessToken, hasValidAccessToken } from '../../lib/auth';
import { toRootPinitId } from '../../lib/pinit-identity';
import { identifyWithFace, loginWithFace, type FacePadEvidence } from '../../lib/face-api-client';
import { collectFingerprint } from '../../lib/device-fingerprint';
import { ensureFaceModels } from '../../lib/face-capture';

type Step = 'welcome' | 'face' | 'entering';

const fade = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  exit:    { opacity: 0, y: -16 },
  transition: { duration: 0.22 },
};

const CLAIM_PREFILL_KEY = LOGIN_CLAIM_PREFILL_KEY;

function userFacingLoginError(msg: string): string {
  const m = msg.toLowerCase();
  if (/camera/.test(m) && /required|unavailable|permission|access/.test(m)) {
    return 'Camera access is required to sign in with Face Scan.';
  }
  if (/not recognized/.test(m)) {
    return "We couldn't tell which account this face belongs to. Enter your Pinit ID and try again.";
  }
  if (/capture_aborted|aborterror/.test(m)) {
    return 'Look at the camera and hold still for a second.';
  }
  if (/pinit id|unknown_claim|no_claim|enter your pinit id/.test(m)) {
    return 'Look at the camera to sign in.';
  }
  if (/follow the on-screen prompts|follow the motion|follow the live motion/.test(m)) {
    return 'Look at the camera.';
  }
  if (/timed out|taking too long/.test(m)) {
    return 'Authentication timed out. The server is taking too long to respond. Please try again.';
  }
  const clean = msg.trim();
  return clean || "Couldn't verify you. Please try again.";
}

export function LoginFlow() {
  const navigate = useNavigate();
  const { loginWithFaceResponse } = useAuth();

  const [step, setStep] = useState<Step>('welcome');
  const [error, setError] = useState('');
  const [claimedShortId, setClaimedShortId] = useState('');
  const [scanAttempts, setScanAttempts] = useState(0);
  const [finishHint, setFinishHint] = useState('Identity verified');
  const faceEmbeddingRef = useRef<number[] | null>(null);
  const padEvidenceRef = useRef<FacePadEvidence | null>(null);
  const lightingRef = useRef<{ status: string; average: number } | null>(null);
  const deviceFpRef = useRef<string>('');
  const claimedShortIdRef = useRef('');
  claimedShortIdRef.current = claimedShortId;

  const go = (s: Step) => { setError(''); setStep(s); };

  const bootRef = useRef(false);
  useEffect(() => {
    if (!bootRef.current) {
      bootRef.current = true;
      let stashed = '';
      try { stashed = sessionStorage.getItem(CLAIM_PREFILL_KEY) || ''; } catch { /* ignore */ }
      const remembered = getStoredShortId() || getLastAccount() || '';
      const jwtShort = parseJwt(getAccessToken() || '')?.shortId || '';
      const claim = toRootPinitId(stashed) || stashed
        || toRootPinitId(remembered) || remembered
        || toRootPinitId(jwtShort) || jwtShort;
      if (claim) {
        setClaimedShortId(claim);
        try { sessionStorage.setItem(CLAIM_PREFILL_KEY, claim); } catch { /* ignore */ }
      }

      if (hasValidAccessToken()) {
        navigate('/welcome', { replace: true });
        return;
      }
    }
    warmBackend();
    void ensureFaceModels();
    collectFingerprint().then((f) => { deviceFpRef.current = f.hash; }).catch(() => {});
  }, [navigate]);

  async function enterAfterLogin() {
    // Standalone face sign-in destination — see WelcomeHello.tsx; not the Hub dashboard.
    navigate('/welcome', { replace: true });
  }

  function startSignIn() {
    setScanAttempts(0);
    setError('');
    go('face');
  }

  function clearClaimedIdentity() {
    forgetRememberedAccount();
    setClaimedShortId('');
    claimedShortIdRef.current = '';
    setScanAttempts(0);
    setError('');
    go('welcome');
  }

  async function applyLoginResult(result: Awaited<ReturnType<typeof loginWithFace>>) {
    if (result.user?.id && result.accessToken) {
      const sub = parseJwt(result.accessToken)?.sub;
      if (sub && sub !== result.user.id) {
        throw new Error("That didn't match. Try again.");
      }
    }
    const claim = (toRootPinitId(claimedShortIdRef.current) || claimedShortIdRef.current).trim();
    const returnedId = (toRootPinitId(result.user?.shortId || '') || result.user?.shortId || '').trim();
    const claimedId = (toRootPinitId(claim) || claim).trim();
    // claimReplaced: the remembered ID belonged to an account that no longer
    // exists, and the server found this person's account by face. Accept it;
    // the stale ID is overwritten below.
    if (returnedId && claimedId && returnedId !== claimedId && !result.claimReplaced) {
      throw new Error("That didn't match. Try again.");
    }
    if (result.claimReplaced) {
      try { sessionStorage.removeItem(CLAIM_PREFILL_KEY); } catch { /* ignore */ }
      try { localStorage.removeItem('pinit_claimed_short_id'); } catch { /* ignore */ }
    }
    loginWithFaceResponse(result);
    const shortId = result.user?.shortId ?? '';
    if (shortId) {
      rememberLastAccount(shortId);
      let deviceFp = '';
      try { deviceFp = (await collectFingerprint()).hash; } catch { /* noop */ }
      saveRegistration({
        hoid: generateHoid(deviceFp),
        shortId,
        trustScore: getTrustScore(),
        deviceFp,
      });
      recordLogin();
    }
  }

  async function submitFaceLogin() {
    const embedding = faceEmbeddingRef.current;
    if (!embedding) throw new Error('Look at the camera and try again.');
    const typedClaim = (toRootPinitId(claimedShortIdRef.current) || claimedShortIdRef.current).trim();
    const deviceFingerprint = (await collectFingerprint().catch(() => ({ hash: '' }))).hash || undefined;
    const padEvidence = padEvidenceRef.current ?? undefined;
    const lightingTelemetry = lightingRef.current
      ? {
          lightingStatus: lightingRef.current.status,
          ambientBrightness: Math.round(lightingRef.current.average),
        }
      : undefined;

    // Only the account shown on screen. A remembered account the person never saw
    // would check a stranger's face against it on a shared computer.
    const claim = typedClaim;
    if (claim) {
      return loginWithFace({
        embedding,
        claimedShortId: claim,
        padEvidence,
        lightingTelemetry,
        deviceFingerprint,
      });
    }
    return identifyWithFace({ embedding, padEvidence, deviceFingerprint });
  }

  async function finishLogin() {
    await applyLoginResult(await submitFaceLogin());
  }

  return (
    <AuthShell steps={0} current={0} tagline="Sign in">
      <AnimatePresence mode="wait">
        <motion.div key={step} {...fade}>
          {step === 'welcome' && (
            <WelcomeHome
              error={error}
              rememberedId={claimedShortId}
              onSignIn={startSignIn}
              onSomeoneElse={clearClaimedIdentity}
              onTypedId={(id) => { setClaimedShortId(id); claimedShortIdRef.current = id; }}
            />
          )}

          {step === 'face' && claimedShortId && (
            <p className="pa-muted" style={{ textAlign: 'center', fontSize: 13, marginBottom: 8 }}>
              Signing in as <b>{claimedShortId}</b>
            </p>
          )}
          {step === 'face' && (
            <FaceRoundScan
              mode="login"
              title="Sign In"
              claimedShortId={claimedShortId}
              scanAttempts={scanAttempts}
              identityError={error}
              onClearIdentity={clearClaimedIdentity}
              onEmbedding={(emb) => { faceEmbeddingRef.current = emb; }}
              onPadEvidence={(ev) => { padEvidenceRef.current = ev; }}
              onLightingSample={(status, average) => {
                lightingRef.current = { status, average };
              }}
              onNext={() => {
                void finishLogin()
                  .then(async () => {
                    setScanAttempts(0);
                    setFinishHint('Identity verified');
                    setStep('entering');
                    setFinishHint('Entering PinITHUB...');
                    await enterAfterLogin();
                  })
                  .catch((e) => {
                    padEvidenceRef.current = null;
                    faceEmbeddingRef.current = null;
                    const nextAttemptCount = scanAttempts + 1;
                    setScanAttempts(nextAttemptCount);
                    const raw = e instanceof Error ? e.message : '';
                    const msg = userFacingLoginError(raw);
                    setError(nextAttemptCount >= 3 ? `${msg} Tap Start Face Scan when you are ready.` : msg);
                  });
              }}
              onError={(m) => {
                const next = scanAttempts + 1;
                setScanAttempts(next);
                const msg = userFacingLoginError(m);
                setError(next >= 3 ? `${msg} Tap Start Face Scan when you are ready.` : msg);
              }}
              onScanStart={() => setError('')}
            />
          )}

          {step === 'entering' && (
            <QuietCameraWait message={finishHint} />
          )}
        </motion.div>
      </AnimatePresence>
    </AuthShell>
  );
}

function WelcomeHome({
  onSignIn,
  onSomeoneElse,
  onTypedId,
  rememberedId,
  error,
}: {
  onSignIn: () => void;
  onSomeoneElse: () => void;
  onTypedId: (id: string) => void;
  rememberedId?: string;
  error?: string;
}) {
  const [typedId, setTypedId] = useState('');
  return (
    <div className="pa-card" style={{ textAlign: 'center' }}>
      <h1 style={{ fontSize: 22, fontWeight: 800 }}>PinITHUB</h1>
      <p className="pa-muted" style={{ fontSize: 14, marginTop: 8 }}>Sign in with Face Scan.</p>
      {rememberedId && (
        <p className="pa-muted" style={{ fontSize: 13, marginTop: 12 }}>
          This browser last signed in as <b>{rememberedId}</b>.
        </p>
      )}
      {error && <p style={{ color: '#F0B1B7', fontSize: 13, marginTop: 12 }}>{error}</p>}
      {!rememberedId && (
        <label style={{ display: 'block', textAlign: 'left', marginTop: 18, fontSize: 13 }}>
          <span className="pa-muted">Your Pinit ID (recommended)</span>
          <input
            className="pa-input"
            style={{ width: '100%', marginTop: 6, textTransform: 'uppercase' }}
            placeholder="PINIT-XXXXXXXX"
            autoComplete="username"
            spellCheck={false}
            value={typedId}
            onChange={(e) => setTypedId(e.target.value.trim().toUpperCase())}
          />
        </label>
      )}
      <button
        className="pa-btn"
        style={{ marginTop: 22 }}
        onClick={() => {
          // A typed ID means the face is checked against that one account only
          if (!rememberedId && typedId) onTypedId(typedId);
          onSignIn();
        }}
      >
        {rememberedId ? `Continue as ${rememberedId}` : 'Sign In'}
      </button>
      {rememberedId && (
        <button
          type="button"
          className="pa-btn pa-btn-ghost"
          style={{ marginTop: 10, textDecoration: 'underline' }}
          onClick={onSomeoneElse}
        >
          Not you? Sign in as someone else
        </button>
      )}
    </div>
  );
}

function QuietCameraWait({ message }: { message: string }) {
  return (
    <div className="pa-card" style={{ textAlign: 'center' }}>
      <h1 style={{ fontSize: 20, fontWeight: 800 }}>Sign In</h1>
      <p className="pa-muted" style={{ fontSize: 13, marginTop: 8 }}>{message}</p>
      <div className="pa-cam-focus" style={{ marginTop: 18 }}>
        <div className="pa-cam lock">
          <div className="pa-cam-lock" aria-hidden>
            <span className="pa-cam-lock-pulse" />
            <ScanFace size={36} color="#A8BEF5" strokeWidth={1.6} />
          </div>
        </div>
      </div>
    </div>
  );
}
