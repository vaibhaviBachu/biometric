import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ShieldCheck, Camera, Sparkles,
  ArrowRight, CheckCircle2, User, Copy, Check,
} from 'lucide-react';

import { AuthShell } from '../../components/auth/AuthShell';
import { FaceRoundScan } from '../../components/auth/FaceRoundScan';
import { StepHead, Checklist, SystemTrace, TrustBadge, type CheckItem } from '../../components/auth/parts';
import { useAuth } from '../../context/AuthContext';
import { collectFingerprint } from '../../lib/device-fingerprint';
import { generateHoid, saveRegistration, forgetRememberedAccount } from '../../lib/hoid';
import { warmBackend } from '../../lib/auth';
import { beginFaceEnrollment, registerFaceIdentity, type FacePadEvidence } from '../../lib/face-api-client';
import { preloadFaceModels } from '../../lib/face-capture';

/** A face-registration failure that means "this face already has an account", not a capture/model error. */
function isDuplicateIdentityError(msg: string): boolean {
  return /already registered|already enrolled|already has a pinit|already has an account|too similar to an existing|duplicate identity|one face = one/i.test(msg);
}

type Step = 'welcome' | 'permissions' | 'face' | 'creating' | 'success';
/** Reserve a Pinit ID, then three live face samples. */
const ORDER: Step[] = ['welcome', 'permissions', 'face', 'creating', 'success'];

const fade = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  exit:    { opacity: 0, y: -16 },
  transition: { duration: 0.22 },
};

export function RegistrationFlow() {
  const navigate = useNavigate();
  const { loginWithFaceResponse } = useAuth();

  const [step, setStep] = useState<Step>('welcome');
  const [error, setError] = useState('');
  /** The minted Pinit ID, surfaced on the success screen so it can be saved. */
  const [newShortId, setNewShortId] = useState('');
  const [reservedId, setReservedId] = useState('');
  const [faceCaptured, setFaceCaptured] = useState(false);
  const deviceFpRef = useRef<string>('');
  const hoidRef = useRef<string>('');
  const faceEmbeddingRef = useRef<number[] | null>(null);
  const padEvidenceRef = useRef<FacePadEvidence | null>(null);
  const samplesRef = useRef<Array<{ embedding: number[]; padEvidence: FacePadEvidence }>>([]);
  const enrollmentTokenRef = useRef('');

  const go = (s: Step) => { setError(''); setStep(s); };
  const idx = ORDER.indexOf(step);

  const sessionResetRef = useRef(false);
  useEffect(() => {
    if (!sessionResetRef.current) {
      sessionResetRef.current = true;
      forgetRememberedAccount();
    }
  }, []);

  useEffect(() => {
    if (step !== 'face' || enrollmentTokenRef.current) return;
    let cancelled = false;
    void beginFaceEnrollment()
      .then((claim) => {
        if (cancelled) return;
        enrollmentTokenRef.current = claim.enrollmentToken;
        setReservedId(claim.shortId);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not reserve a Pinit ID.');
      });
    return () => { cancelled = true; };
  }, [step]);

  function afterFace() {
    if (samplesRef.current.length < 3) {
      setError('Three clear face samples are required.');
      return;
    }
    setFaceCaptured(true);
    if (!enrollmentTokenRef.current) {
      setError('Reserving your Pinit ID…');
      return;
    }
    hoidRef.current = generateHoid(deviceFpRef.current);
    go('creating');
  }

  useEffect(() => {
    if (step !== 'face' || !faceCaptured || !enrollmentTokenRef.current) return;
    hoidRef.current = generateHoid(deviceFpRef.current);
    go('creating');
  }, [step, faceCaptured, reservedId]);

  return (
    <AuthShell steps={ORDER.length} current={idx} tagline="Create Biometric Identity">
      <AnimatePresence mode="wait">
        <motion.div key={step} {...fade}>
          {step === 'welcome'     && (
            <Welcome onNext={() => go('permissions')} />
          )}
          {step === 'permissions' && <Permissions deviceFpRef={deviceFpRef} onNext={() => go('face')} />}
          {step === 'face'        && (
            <>
              {reservedId && (
                <p className="pa-muted" style={{ textAlign: 'center', fontSize: 13, marginBottom: 8 }}>
                  Pinit ID {reservedId} is reserved. It stays empty until these face samples pass.
                </p>
              )}
              <FaceRoundScan
                mode="register"
                samplesRequired={3}
                identityError={error}
                onEmbedding={(emb) => { faceEmbeddingRef.current = emb; }}
                onPadEvidence={(ev) => { padEvidenceRef.current = ev; }}
                onSample={(sample) => { samplesRef.current = [...samplesRef.current, sample]; }}
                onNext={afterFace}
                onError={(m) => setError(m)}
              />
              {!reservedId && error && (
                <button
                  type="button"
                  className="pa-btn pa-btn-ghost"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    enrollmentTokenRef.current = '';
                    setError('');
                    void beginFaceEnrollment()
                      .then((claim) => {
                        enrollmentTokenRef.current = claim.enrollmentToken;
                        setReservedId(claim.shortId);
                      })
                      .catch((err) => setError(err instanceof Error ? err.message : 'Could not reserve a Pinit ID.'));
                  }}
                >
                  Reserve Pinit ID again
                </button>
              )}
            </>
          )}
          {step === 'creating'    && (
            <Creating
              error={error}
              run={async () => {
                const embedding = faceEmbeddingRef.current;
                if (!embedding || samplesRef.current.length < 3 || !enrollmentTokenRef.current) {
                  throw new Error('Three live face samples and a reserved Pinit ID are required.');
                }

                const result = await registerFaceIdentity({
                  embedding,
                  samples: samplesRef.current,
                  enrollmentToken: enrollmentTokenRef.current || undefined,
                  padEvidence: padEvidenceRef.current ?? undefined,
                  deviceFingerprint: deviceFpRef.current || undefined,
                  // Hub is released for Personal accounts only.
                  accountType: 'INDIVIDUAL',
                });

                loginWithFaceResponse(result);
                const shortId = result.user?.shortId ?? '';
                setNewShortId(shortId);
                const hoid = hoidRef.current || generateHoid(deviceFpRef.current);
                saveRegistration({
                  hoid,
                  shortId,
                  trustScore: 99.8,
                  deviceFp: deviceFpRef.current,
                });
              }}
              onDone={() => go('success')}
              onError={(m) => setError(m)}
              onDuplicate={() => navigate('/login', { replace: true })}
              onRetryCapture={() => {
                // Each liveness challenge token is single-use — resubmitting the same
                // captured samples (what this used to do) always fails as a replay,
                // showing a scary "use a live camera" message no matter what the real
                // problem was. A retry must re-scan from scratch, not resubmit.
                faceEmbeddingRef.current = null;
                padEvidenceRef.current = null;
                samplesRef.current = [];
                setFaceCaptured(false);
                go('face');
              }}
            />
          )}
          {step === 'success'     && (
            <Success
              shortId={newShortId}
              onEnter={() => navigate('/welcome', { replace: true })}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </AuthShell>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="pa-card" style={{ textAlign: 'center' }}>
      <StepHead
        icon={<User size={26} color="#0F4FF2" />}
        title="Create your PinITHUB identity"
        subtitle="Free plan. Your face identifies you."
      />
      <div className="pa-bio-steps">
        <div className="pa-bio-step">
          <Camera size={18} color="#0F4FF2" style={{ margin: '0 auto' }} />
          <span>Face</span>
          <em>3 samples</em>
        </div>
      </div>
      <button className="pa-btn" onClick={onNext}>Start biometric setup <ArrowRight size={17} /></button>
    </div>
  );
}

function Permissions({ deviceFpRef, onNext }: { deviceFpRef: React.MutableRefObject<string>; onNext: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function allow() {
    setBusy(true);
    setErr('');
    warmBackend();
    preloadFaceModels();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      setErr('Camera access is required for face enrollment.');
      setBusy(false);
      return;
    }
    try { deviceFpRef.current = (await collectFingerprint()).hash; } catch { /* noop */ }
    setBusy(false);
    onNext();
  }

  return (
    <div className="pa-card">
      <StepHead icon={<ShieldCheck size={26} color="#0F4FF2" />} title="Permissions" subtitle="Camera is required." />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 20 }}>
        {[
          { icon: <Camera size={18} />, label: 'Camera', sub: 'Round face scan' },
        ].map((p) => (
          <div key={p.label} className="pa-check">
            <span style={{ color: '#0F4FF2', display: 'flex' }}>{p.icon}</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#F9F9FA' }}>{p.label}</div>
              <div className="pa-faint" style={{ fontSize: 12 }}>{p.sub}</div>
            </div>
          </div>
        ))}
      </div>
      {err && <p style={{ color: '#F0B1B7', fontSize: 13, marginBottom: 12 }}>{err}</p>}
      <button className="pa-btn" onClick={allow} disabled={busy}>{busy ? 'Requesting…' : <>Allow &amp; Continue <ArrowRight size={17} /></>}</button>
    </div>
  );
}

function Creating({
  run, onDone, onError, onDuplicate, onRetryCapture, error,
}: {
  run: () => Promise<void>;
  onDone: () => void;
  onError: (m: string) => void;
  onDuplicate: () => void;
  onRetryCapture: () => void;
  error: string;
}) {
  const INITIAL: CheckItem[] = [
    { label: 'Face Captured', done: false },
    { label: 'Saved to Database', done: false },
  ];
  const [items, setItems] = useState<CheckItem[]>(INITIAL);
  const ranRef = useRef(false);
  const duplicate = isDuplicateIdentityError(error);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    onError('');
    setItems(INITIAL.map((it) => ({ ...it, done: false })));
    INITIAL.slice(0, INITIAL.length - 1).forEach((_, i) =>
      setTimeout(() => setItems((prev) => prev.map((it, j) => (j <= i ? { ...it, done: true } : it))), 280 * (i + 1))
    );
    run()
      .then(() => {
        setItems((prev) => prev.map((it) => ({ ...it, done: true })));
        setTimeout(onDone, 900);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : 'Registration failed.';
        // A "looks like an existing account" answer is only a face resemblance. Never move on to
        // sign-in by ourselves: a lookalike would then be checked against someone else's account.
        onError(msg);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pa-card">
      <StepHead icon={<Sparkles size={26} color="#0F4FF2" />} title="Saving to Database" subtitle="Checking you are not already registered…" />
      <Checklist items={items} />
      <SystemTrace lines={['Reserve the Pinit ID', 'Check three live samples', 'Create the account']} />
      {error && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <p style={{ color: duplicate ? '#595C64' : '#F0B1B7', fontSize: 13 }}>{error}</p>
          {duplicate ? (
            <>
              <p className="pa-muted" style={{ fontSize: 12, marginTop: 6 }}>
                This face looks very close to an existing account. If it is your account, sign in with your Pinit ID.
                If it is not, contact info@pinit.in and we will set up your account.
              </p>
              <button className="pa-btn pa-btn-ghost" style={{ marginTop: 10 }} onClick={onDuplicate}>It's my account, sign in</button>
            </>
          ) : (
            <button className="pa-btn" style={{ marginTop: 12 }} onClick={onRetryCapture}>Retry</button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Registration success — the one moment the new Pinit ID is shown.
 *
 * This used to auto-advance after 1.6s without ever displaying the ID, so a
 * new user never saw their own identity. It no longer moves on by itself:
 * signing in normally is done by face, but the ID is the recovery path and is
 * worth a deliberate moment to copy.
 */
function Success({ shortId, onEnter }: { shortId?: string; onEnter: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!shortId) return;
    try {
      await navigator.clipboard.writeText(shortId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the ID is on screen to copy by hand */
    }
  };

  return (
    <div className="pa-card" style={{ textAlign: 'center' }}>
      <div className="pa-pop" style={{ width: 76, height: 76, margin: '4px auto 16px', borderRadius: '50%', background: '#5E616B', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 34px rgba(94,97,107,0.65)' }}>
        <CheckCircle2 size={42} color="#fff" />
      </div>
      <h1 style={{ fontSize: 23, fontWeight: 800 }}>Welcome to PinITHUB</h1>

      {shortId && (
        <>
          <p className="pa-muted" style={{ fontSize: 13, marginTop: 10 }}>
            Your Pinit ID
          </p>
          <div style={{
            margin: '8px auto 0', padding: '12px 14px', maxWidth: 320,
            borderRadius: 12, border: '1px solid rgba(15,79,242,0.35)',
            background: 'rgba(10,11,12,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          }}>
            <code style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0.8, color: '#EFF0F1' }}>
              {shortId}
            </code>
            <button
              type="button"
              onClick={copy}
              title="Copy Pinit ID"
              aria-label="Copy Pinit ID"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: copied ? '#7C808B' : '#0F4FF2', fontSize: 12, fontWeight: 700,
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="pa-muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.5, maxWidth: 330, margin: '10px auto 0' }}>
            You won&apos;t need this to sign in — just scan your face. Keep it
            somewhere safe as a backup way into your account.
          </p>
        </>
      )}

      <div style={{ margin: '18px 0' }}><TrustBadge score={99.8} /></div>
      <button className="pa-btn" onClick={onEnter}>Enter PinITHUB <ArrowRight size={17} /></button>
    </div>
  );
}
