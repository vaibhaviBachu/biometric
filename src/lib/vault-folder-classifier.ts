/**
 * Decides which My Work folder a pinned file belongs in.
 *
 * Every rule adds evidence for one folder with a weight (0–1). Evidence for
 * the same folder is combined (noisy-OR), so two independent hints are
 * stronger than one. Content evidence (document text, OCR text, the
 * description) outweighs the file name and type.
 *
 * Safety rules, in order:
 *   1. Identity, then finance, win over any weaker category once they clear
 *      the sensitive bar — a sensitive file must never land in a public folder
 *      because a broader rule also matched.
 *   2. A file name that points one way while the contents point another goes
 *      to To sort, never filed silently.
 *   3. Anything below the confidence bar goes to To sort with its best guess.
 *
 * Pure and synchronous: no I/O, nothing stored, safe to unit test.
 */

export const VAULT_FOLDER_IDS = [
  'ids',
  'finance',
  'education',
  'work',
  'gallery',
  'videos',
  'documents',
  'audio',
  'tosort',
] as const;

export type VaultFolderId = (typeof VAULT_FOLDER_IDS)[number];

/** Kept off Portfolio, Exchange and public Scan; opening needs a face check. */
export const PRIVATE_VAULT_FOLDERS: ReadonlySet<VaultFolderId> = new Set<VaultFolderId>(['ids', 'finance']);

export function isVaultFolderId(value: unknown): value is VaultFolderId {
  return typeof value === 'string' && (VAULT_FOLDER_IDS as readonly string[]).includes(value);
}

export function isPrivateVaultFolder(value: unknown): boolean {
  return isVaultFolderId(value) && PRIVATE_VAULT_FOLDERS.has(value);
}

/** A file is filed without asking only at or above this confidence. */
export const AUTO_FILE_CONFIDENCE = 0.75;
/** Identity or finance evidence at or above this wins over other categories. */
const SENSITIVE_BAR = 0.6;
/** Content evidence this strong, disagreeing with a name rule, is a conflict. */
const CONFLICT_CONTENT_BAR = 0.6;

export interface FolderSignals {
  fileName: string;
  mimeType?: string | null;
  contentLabel?: string | null;
  /** Document or OCR text. Read in memory only; never stored by the classifier. */
  text?: string | null;
  /** The two-line description, when one exists. */
  description?: string | null;
  /** Protect capture method, e.g. "Upload", "PinIT Camera", "PinIT Document Scan". */
  captureMethod?: string | null;
  hasCameraExif?: boolean;
  isScreenshot?: boolean;
  courseKeywordsHit?: string[];
  /**
   * True when the contents were actually read (text extraction or OCR ran).
   * False when reading was skipped (file too large) or failed.
   */
  contentRead?: boolean;
}

export interface FolderEvidence {
  folder: Exclude<VaultFolderId, 'tosort'>;
  weight: number;
  source: 'content' | 'name' | 'type';
  label: string;
}

export interface FolderDecision {
  /** Where the file goes now. `tosort` when not confident. */
  folder: VaultFolderId;
  /** Best guess when `folder` is `tosort`; otherwise null. */
  suggestion: VaultFolderId | null;
  /** 0–100 confidence in `folder` (or in `suggestion` when sent to To sort). */
  confidence: number;
  /** Plain-language reason shown to the owner. */
  reason: string;
  /** True when filed without asking (confidence at or above the bar). */
  autoFiled: boolean;
  /** Labels of the rules that fired. Never contains file text. */
  evidence: string[];
}

type Target = Exclude<VaultFolderId, 'tosort'>;

interface ContentRule {
  folder: Target;
  weight: number;
  label: string;
  test: (text: string, raw: string) => boolean;
}

const re = (pattern: RegExp) => (text: string) => pattern.test(text);

// ── Strong structural checks (numbers that verify) ────────────────────────────

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Aadhaar numbers carry a Verhoeff check digit and never start with 0 or 1. */
export function isValidAadhaarNumber(digits: string): boolean {
  if (!/^[2-9]\d{11}$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split('').reverse().map(Number);
  for (let i = 0; i < reversed.length; i += 1) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversed[i]]];
  }
  return c === 0;
}

function hasValidAadhaarNumber(raw: string): boolean {
  const matches = raw.match(/\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g) ?? [];
  return matches.some((m) => isValidAadhaarNumber(m.replace(/[\s-]/g, '')));
}

/** PAN format: 5 letters, 4 digits, 1 letter; the 4th letter is the holder type. */
function hasPanNumber(raw: string): boolean {
  return /\b[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z]\b/.test(raw);
}

function hasIfsc(raw: string): boolean {
  return /\b[A-Z]{4}0[A-Z0-9]{6}\b/.test(raw);
}

/** A resume is a stack of standard section headings; a marksheet or letter is not. */
function resumeSections(text: string): number {
  const headings = [
    /\b(work |professional )?experience\b/, /\bskills\b/, /\bprojects\b/, /\beducation\b/,
    /\bcertifications?\b/, /\binternships?\b/, /\b(objective|summary)\b/, /\blinkedin\b/, /\bachievements\b/,
  ];
  return headings.filter((h) => h.test(text)).length;
}

// ── Content rules (matched against lower-cased text + description) ────────────
// Weights: ≥0.9 the document identifies itself; ~0.8 clear wording; ~0.7 a
// telling phrase that also appears in other kinds of paper.

const CONTENT_RULES: ContentRule[] = [
  // Identity & IDs
  { folder: 'ids', weight: 0.95, label: 'Aadhaar number', test: (_t, raw) => hasValidAadhaarNumber(raw) },
  { folder: 'ids', weight: 0.95, label: 'Aadhaar card', test: re(/unique identification authority|\buidai\b|आधार|enrolment no|enrollment no|\bvid\s*:?\s*\d{4}/) },
  { folder: 'ids', weight: 0.7, label: 'Mentions Aadhaar', test: re(/\b(aadhaa?r|adhaa?r|aadhhar)\b/) },
  { folder: 'ids', weight: 0.95, label: 'PAN card', test: re(/permanent account number|income tax department/) },
  { folder: 'ids', weight: 0.65, label: 'PAN number', test: (_t, raw) => hasPanNumber(raw) },
  { folder: 'ids', weight: 0.95, label: 'Passport', test: (t, raw) => /p<ind/i.test(raw) || (/\bpassport\b/.test(t) && /republic of india|nationality|place of issue/.test(t)) },
  { folder: 'ids', weight: 0.7, label: 'Mentions passport', test: re(/\bpassport (no|number)\b/) },
  { folder: 'ids', weight: 0.9, label: 'Driving licence', test: re(/driving licen[cs]e|driver'?s? licen[cs]e|\bdl no\b|transport department/) },
  { folder: 'ids', weight: 0.9, label: 'Voter ID', test: re(/election commission of india|elector'?s? photo identity|\bepic no\b/) },
  { folder: 'ids', weight: 0.85, label: 'Ration card', test: re(/\bration card\b|public distribution system/) },
  { folder: 'ids', weight: 0.85, label: 'Government certificate', test: re(/\b(birth|caste|income|domicile|residence|disability|community) certificate\b|tahsildar|registrar of births/) },
  { folder: 'ids', weight: 0.75, label: 'ID card', test: re(/\b(identity card|id card)\b/) },
  { folder: 'ids', weight: 0.9, label: 'Identity document', test: re(/identity or official document/) },

  // Bank & Finance
  { folder: 'finance', weight: 0.9, label: 'Bank statement', test: re(/\b(bank statement|account statement|statement of account|opening balance|closing balance|passbook)\b/) },
  { folder: 'finance', weight: 0.85, label: 'Cheque', test: (t, raw) => /\bcheque\b|\bmicr\b|pay\s+.*\bor bearer\b/.test(t) || (hasIfsc(raw) && /\bbank\b/.test(t)) },
  { folder: 'finance', weight: 0.9, label: 'Tax document', test: re(/\bform\s?(16|26as)\b|income tax return|\bitr-?\d\b|tax deducted at source|\bgst return\b|\bgstr-?\d/) },
  { folder: 'finance', weight: 0.9, label: 'Payslip', test: re(/\b(salary slip|pay ?slip|net pay|gross salary|earnings and deductions)\b/) },
  { folder: 'finance', weight: 0.85, label: 'Insurance', test: re(/\b(policy number|policy no|sum assured|premium amount|insurance policy|policy holder|policyholder)\b/) },
  { folder: 'finance', weight: 0.85, label: 'Financial statement', test: re(/\b(mutual fund|consolidated account statement|demat|folio no|credit card statement|loan account|emi schedule|fixed deposit|sanction letter)\b/) },
  { folder: 'finance', weight: 0.8, label: 'Bill or receipt', test: re(/\b(invoice no|invoice number|tax invoice|receipt no|amount paid|total amount|bill no|bill date|due date|gstin|electricity bill|rent receipt)\b/) },
  { folder: 'finance', weight: 0.85, label: 'Payment', test: re(/\b(upi|utr|transaction id|paid to|payment successful|money sent|debited from|credited to)\b/) },
  { folder: 'finance', weight: 0.7, label: 'Bank name', test: re(/\b(state bank of india|hdfc bank|icici bank|axis bank|kotak mahindra|canara bank|punjab national bank|bank of baroda|union bank of india|idfc first|yes bank|indusind bank)\b/) },

  // Education
  { folder: 'education', weight: 0.9, label: 'Marksheet', test: re(/\b(mark ?sheet|grade card|statement of marks|marks memo|transcript|cgpa|sgpa)\b/) },
  { folder: 'education', weight: 0.85, label: 'Degree or certificate', test: re(/\b(degree certificate|provisional certificate|convocation|diploma in|bachelor of|master of|certificate of (completion|achievement|participation|internship|merit|excellence)|transfer certificate|migration certificate|bonafide certificate)\b/) },
  { folder: 'education', weight: 0.85, label: 'Admit card', test: re(/\b(admit card|hall ticket|roll no|seat no|examination centre)\b/) },
  { folder: 'education', weight: 0.75, label: 'Course work', test: re(/\b(assignment|lecture|syllabus|question paper|lab manual|course code|semester)\b/) },
  { folder: 'education', weight: 0.8, label: 'Research paper', test: (t) => /\babstract\b/.test(t) && /\b(references|bibliography|doi)\b/.test(t) },
  { folder: 'education', weight: 0.6, label: 'School or university', test: re(/\b(university|college|school|board of (secondary|higher secondary) education|cbse|icse)\b/) },

  // Work & Career
  { folder: 'work', weight: 0.95, label: 'Resume', test: (t) => /\b(curriculum vitae|resume|professional summary|career objective)\b/.test(t) || resumeSections(t) >= 3 },
  { folder: 'work', weight: 0.8, label: 'Offer or experience letter', test: re(/\b(offer letter|letter of offer|appointment letter|experience letter|relieving letter|annual ctc|cost to company)\b/) },
  { folder: 'work', weight: 0.75, label: 'Client deliverable', test: re(/\b(proposal|statement of work|deliverables|client brief|brand guidelines|creative brief)\b/) },

  // Documents
  { folder: 'documents', weight: 0.85, label: 'Medical record', test: re(/\b(prescription|diagnosis|patient name|lab report|haemoglobin|hemoglobin|discharge summary|\brx\b|blood test)\b/) },
  { folder: 'documents', weight: 0.85, label: 'Ticket or booking', test: re(/\b(boarding pass|e-ticket|\bpnr\b|booking id|booking reference|flight no)\b/) },
  { folder: 'documents', weight: 0.8, label: 'Agreement', test: re(/\b(agreement|hereinafter|witnesseth|lessor|lessee|landlord|tenant|affidavit|power of attorney)\b/) },
  { folder: 'documents', weight: 0.7, label: 'Manual or warranty', test: re(/\b(user manual|instruction manual|warranty card|warranty period)\b/) },
];

interface NameRule {
  folder: Target;
  weight: number;
  label: string;
  pattern: RegExp;
}

/** Matched against the file name with separators turned into spaces. */
const NAME_RULES: NameRule[] = [
  { folder: 'ids', weight: 0.5, label: 'Name says Aadhaar', pattern: /\b(aadhaa?r|adhaa?r|aadhhar|e ?aadhaar|uidai)\b/ },
  { folder: 'ids', weight: 0.5, label: 'Name says PAN', pattern: /\bpan ?card\b|\bpan\b/ },
  { folder: 'ids', weight: 0.5, label: 'Name says passport', pattern: /\bpassport\b/ },
  { folder: 'ids', weight: 0.5, label: 'Name says licence', pattern: /\bdriving ?licen[cs]e\b|\bdl\b/ },
  { folder: 'ids', weight: 0.5, label: 'Name says voter ID', pattern: /\bvoter ?(id)?\b|\bepic\b/ },
  { folder: 'ids', weight: 0.45, label: 'Name says ID card', pattern: /\b(id ?card|ration ?card|birth ?certificate|caste ?certificate|income ?certificate)\b/ },
  { folder: 'finance', weight: 0.5, label: 'Name says bank', pattern: /\b(bank ?statement|account ?statement|passbook|cheque|sbi|hdfc|icici|axis|kotak)\b/ },
  { folder: 'finance', weight: 0.5, label: 'Name says tax', pattern: /\b(form ?16|itr|tds|gst|26as)\b/ },
  { folder: 'finance', weight: 0.45, label: 'Name says payslip', pattern: /\b(salary|pay ?slip)\b/ },
  { folder: 'finance', weight: 0.45, label: 'Name says bill', pattern: /\b(invoice|receipt|bill|insurance|upi|payment)\b/ },
  { folder: 'education', weight: 0.45, label: 'Name says marksheet', pattern: /\b(mark ?sheet|marks|grade ?card|transcript|sem ?\d+|semester|degree|diploma|certificate|admit ?card|hall ?ticket)\b/ },
  { folder: 'education', weight: 0.4, label: 'Name says course work', pattern: /\b(assignment|notes|lecture|syllabus|homework|thesis|research|exam)\b/ },
  { folder: 'work', weight: 0.45, label: 'Name says resume', pattern: /\b(resume|cv|offer ?letter|experience ?letter|portfolio)\b/ },
  { folder: 'work', weight: 0.4, label: 'Name says design', pattern: /\b(logo|poster|design|mockup|artwork|banner|final|v\d+|edit(ed)?|reel)\b/ },
  { folder: 'documents', weight: 0.4, label: 'Name says document', pattern: /\b(agreement|contract|letter|prescription|report|ticket|boarding|manual|warranty)\b/ },
];

const AUDIO_EXT = /\.(mp3|m4a|wav|aac|ogg|opus|flac|weba|amr)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|bmp|tiff?)$/i;
const PHOTO_EXT = /\.(jpe?g|heic|heif)$/i;
const DESIGN_EXT = /\.(psd|ai|fig|sketch|xd|eps|indd|svg|afdesign|cdr|blend|obj|fbx)$/i;
const CODE_ARCHIVE = /\.(zip|rar|7z|tar|gz)$/i;
const DOC_EXT = /\.(pdf|docx?|txt|rtf|odt|pptx?|xlsx?|csv|md|json|html?)$/i;

const PRIORITY: Target[] = ['ids', 'finance', 'education', 'work', 'gallery', 'videos', 'documents', 'audio'];

const FOLDER_LABEL: Record<Target, string> = {
  ids: 'Identity & IDs',
  finance: 'Bank & Finance',
  education: 'Education',
  work: 'Work & Career',
  gallery: 'Gallery',
  videos: 'Videos',
  documents: 'Documents',
  audio: 'Audio',
};

function nameWords(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.()[\]]+/g, ' ')
    .toLowerCase();
}

function isCameraCapture(method: string | null | undefined): boolean {
  const m = (method || '').toLowerCase();
  return m.includes('camera') || m.includes('video capture');
}

function isDocumentScan(method: string | null | undefined): boolean {
  return (method || '').toLowerCase().includes('document scan');
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Words a person could read, not the noise text reading finds in a photo's texture (2026-11-20).
 * A Latin word: 3 to 18 letters with a vowel and no letter repeated three times in a row ("lll", "iii").
 * Indian scripts (Devanagari, Telugu, Tamil, Kannada, Malayalam, Bengali, Gujarati, Gurmukhi, Odia): 2+ letters.
 * A number with 4+ digits also counts (an ID, a phone number, an amount on a page).
 */
export function realWordCount(text: string): number {
  let count = 0;
  for (const token of text.split(/\s+/)) {
    const t = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!t) continue;
    if (/^[A-Za-z]{3,18}$/.test(t) && /[aeiouyAEIOUY]/.test(t) && !/(.)/i.test(t)) count += 1;
    else if (/^[ऀ-෿਀-૿]{2,}$/.test(t)) count += 1;
    else if (/^\d{4,}$/.test(t)) count += 1;
  }
  return count;
}

function combine(weights: number[]): number {
  // Rounded so one 0.45 hint scores exactly 0.45, not 0.44999….
  const raw = 1 - weights.reduce((acc, w) => acc * (1 - w), 1);
  return Math.min(0.99, Math.round(raw * 10_000) / 10_000);
}

function pct(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

/** Every piece of evidence the rules find. Exported for tests and diagnostics. */
export function collectFolderEvidence(signals: FolderSignals): FolderEvidence[] {
  const evidence: FolderEvidence[] = [];
  const mime = (signals.mimeType || '').toLowerCase();
  const name = signals.fileName || '';
  const words = nameWords(name);
  const raw = `${(signals.text || '').slice(0, 40_000)}\n${signals.description || ''}`;
  const text = raw.toLowerCase().replace(/\s+/g, ' ');
  const label = (signals.contentLabel || '').toUpperCase();
  // Photos are judged by real words only: texture noise must not make a photo look like a page.
  const readable = wordCount(signals.text || '');
  const realWords = realWordCount(signals.text || '');

  for (const rule of CONTENT_RULES) {
    if (rule.test(text, raw)) evidence.push({ folder: rule.folder, weight: rule.weight, source: 'content', label: rule.label });
  }
  for (const rule of NAME_RULES) {
    if (rule.pattern.test(words)) evidence.push({ folder: rule.folder, weight: rule.weight, source: 'name', label: rule.label });
  }
  if (label === 'COURSE_MATERIAL' || (signals.courseKeywordsHit?.length ?? 0) > 0) {
    evidence.push({ folder: 'education', weight: 0.7, source: 'content', label: 'Course material' });
  }

  const isAudio = mime.startsWith('audio/') || AUDIO_EXT.test(name);
  const isVideo = mime.startsWith('video/') || VIDEO_EXT.test(name);
  const isImage = mime.startsWith('image/') || IMAGE_EXT.test(name);
  const isDesign = DESIGN_EXT.test(name) || mime.includes('svg') || mime.includes('photoshop');
  const isDocument = DOC_EXT.test(name)
    || mime.includes('pdf') || mime.includes('word') || mime.includes('text/')
    || mime.includes('presentation') || mime.includes('spreadsheet') || mime.includes('rtf');

  if (isAudio) evidence.push({ folder: 'audio', weight: 0.97, source: 'type', label: 'Audio file' });
  if (isDesign) evidence.push({ folder: 'work', weight: 0.9, source: 'type', label: 'Design file' });
  if (CODE_ARCHIVE.test(name)) {
    evidence.push(/\b(src|code|project|app|repo|build|source)\b/.test(words)
      ? { folder: 'work', weight: 0.8, source: 'type', label: 'Code archive' }
      : { folder: 'documents', weight: 0.76, source: 'type', label: 'Archive' });
  }

  if (isVideo) {
    evidence.push(isCameraCapture(signals.captureMethod)
      ? { folder: 'videos', weight: 0.9, source: 'type', label: 'Video from your camera' }
      : { folder: 'videos', weight: 0.9, source: 'type', label: 'Video' });
  }

  if (isImage && !isDesign) {
    const camera = isCameraCapture(signals.captureMethod) || Boolean(signals.hasCameraExif);
    const screenshot = label === 'SCREENSHOT' || Boolean(signals.isScreenshot);
    const pageLike = isDocumentScan(signals.captureMethod) || realWords >= 25;
    // Words that say ID / finance / education / work decide; the picture type only fills in when they say nothing.
    const specific = evidence.some((e) => e.source === 'content');
    if (screenshot && !isDocumentScan(signals.captureMethod)) {
      // A screenshot belongs in Gallery, however much app text (tabs, menus, buttons) it shows. If its words name
      // an ID, a payment, a marksheet or a resume, that content decides instead (the weight steps back).
      evidence.push({ folder: 'gallery', weight: specific ? 0.5 : 0.8, source: 'type', label: 'Screenshot' });
    } else if (pageLike) {
      // A photo or scan of a page: its words say what it is; with nothing specific it is a document.
      evidence.push({ folder: 'documents', weight: specific ? 0.5 : 0.78, source: 'type', label: 'Photo of a page' });
    } else if (realWords >= 8 && signals.contentRead !== false) {
      // Some words but not a page: a screenshot of an app, or a photo of a sign or a menu. Both belong in Gallery.
      evidence.push({ folder: 'gallery', weight: specific ? 0.6 : (screenshot ? 0.8 : 0.78), source: 'type', label: screenshot ? 'Screenshot' : 'Image with some text' });
    } else if (screenshot) {
      evidence.push({ folder: 'gallery', weight: 0.8, source: 'type', label: 'Screenshot' });
    } else if (camera) {
      evidence.push({ folder: 'gallery', weight: 0.85, source: 'type', label: 'Camera photo' });
    } else if (label === 'AI_GENERATED' || label === 'AI_EDITED') {
      evidence.push({ folder: 'work', weight: 0.8, source: 'type', label: 'Artwork or edited image' });
    } else if (mime === 'image/gif' || /\.gif$/i.test(name)) {
      evidence.push({ folder: 'gallery', weight: 0.8, source: 'type', label: 'GIF' });
    } else {
      // A picture with no words to read (or too large to read): the type is the best signal.
      evidence.push({
        folder: 'gallery',
        weight: PHOTO_EXT.test(name) || mime === 'image/jpeg' || mime.includes('heic') ? 0.8 : 0.76,
        source: 'type',
        label: 'Photo',
      });
    }
  }

  if (isDocument && !isDesign) {
    // "It is a document" only decides when the words say nothing more specific.
    const specific = evidence.some((e) => e.source === 'content' && e.folder !== 'documents');
    if (signals.contentRead && readable >= 5) {
      evidence.push({ folder: 'documents', weight: specific ? 0.3 : 0.78, source: 'type', label: 'Document' });
    } else {
      evidence.push({ folder: 'documents', weight: 0.4, source: 'type', label: 'Document (text not read)' });
    }
  }

  if (evidence.length === 0) {
    evidence.push({ folder: 'documents', weight: 0.4, source: 'type', label: 'File' });
  }
  return evidence;
}

export function classifyVaultFolder(signals: FolderSignals): FolderDecision {
  const evidence = collectFolderEvidence(signals);
  const scores = new Map<Target, number>();
  const contentScores = new Map<Target, number>();
  const nameScores = new Map<Target, number>();
  for (const folder of PRIORITY) {
    const all = evidence.filter((e) => e.folder === folder);
    scores.set(folder, combine(all.map((e) => e.weight)));
    contentScores.set(folder, combine(all.filter((e) => e.source === 'content').map((e) => e.weight)));
    nameScores.set(folder, combine(all.filter((e) => e.source === 'name').map((e) => e.weight)));
  }
  const labels = [...new Set(evidence.map((e) => e.label))];
  const score = (f: Target) => scores.get(f) ?? 0;
  const argmax = (map: Map<Target, number>, among: Target[] = PRIORITY) =>
    among.reduce((a, b) => ((map.get(b) ?? 0) > (map.get(a) ?? 0) ? b : a), among[0]);
  const toSort = (suggestion: Target, confidence: number, reason: string): FolderDecision => ({
    folder: 'tosort', suggestion, confidence: pct(confidence), reason, autoFiled: false, evidence: labels,
  });

  // 1. Conflict: the name points one way, the contents firmly another.
  const contentBest = argmax(contentScores);
  const contentBestScore = contentScores.get(contentBest) ?? 0;
  const nameBest = argmax(nameScores);
  const nameBestScore = nameScores.get(nameBest) ?? 0;
  // Only a specific name ("aadhaar", "marksheet", "resume") can conflict; generic
  // hints like "letter" or "notes" just add weight.
  if (
    nameBestScore >= 0.45
    && contentBestScore >= CONFLICT_CONTENT_BAR
    && nameBest !== contentBest
    && (nameScores.get(contentBest) ?? 0) === 0
    // The contents also back the name (a resume that mentions a university): no conflict.
    && (contentScores.get(nameBest) ?? 0) === 0
  ) {
    const suggestion: Target = isPrivateVaultFolder(nameBest) && !isPrivateVaultFolder(contentBest) ? nameBest : contentBest;
    return toSort(
      suggestion,
      Math.min(contentBestScore, 0.7),
      `The file name suggests ${FOLDER_LABEL[nameBest]}, but its contents look like ${FOLDER_LABEL[contentBest]}`,
    );
  }

  // 2. Sensitive first: identity or finance evidence over the bar beats weaker matches.
  const sensitive = (['ids', 'finance'] as const)
    .filter((f) => score(f) >= SENSITIVE_BAR)
    .sort((a, b) => score(b) - score(a));
  const others = PRIORITY.filter((f) => !isPrivateVaultFolder(f));
  const otherBest = argmax(scores, others);
  let best: Target;
  if (sensitive.length > 0) {
    best = sensitive[0];
    if (score(otherBest) > score(best) + 0.15) {
      // Mixed: clearly another kind of file that also carries personal details.
      return toSort(
        best,
        score(best),
        `Looks like ${FOLDER_LABEL[otherBest]} but also contains ${best === 'ids' ? 'identity' : 'financial'} details`,
      );
    }
  } else {
    best = argmax(scores);
    // 3. A name that says "Aadhaar" or "bank" is never overruled by file type alone.
    //    Unless the contents firmly say otherwise, the file goes straight into that
    //    private folder: filing a sensitive file privately is the safe mistake.
    const sensitiveName = (['ids', 'finance'] as const).find((f) => (nameScores.get(f) ?? 0) >= 0.45);
    if (sensitiveName) {
      const nameScore = nameScores.get(sensitiveName) ?? 0.45;
      if (contentBestScore < CONFLICT_CONTENT_BAR || contentBest === sensitiveName) {
        const nameLabel = evidence.find((e) => e.folder === sensitiveName && e.source === 'name')?.label;
        return {
          folder: sensitiveName,
          suggestion: null,
          confidence: pct(nameScore),
          reason: signals.contentRead === false
            ? `${nameLabel ?? 'File name'} — kept private; PINIT couldn't read the file to double-check`
            : (nameLabel ?? 'File name'),
          autoFiled: true,
          evidence: labels,
        };
      }
      return toSort(
        sensitiveName,
        nameScore,
        `The file name suggests ${FOLDER_LABEL[sensitiveName]} — please confirm`,
      );
    }
  }
  const bestScore = score(best);

  const top = evidence
    .filter((e) => e.folder === best)
    .sort((a, b) => b.weight - a.weight)[0];
  const reason = top?.label ?? FOLDER_LABEL[best];

  if (bestScore >= AUTO_FILE_CONFIDENCE) {
    return { folder: best, suggestion: null, confidence: pct(bestScore), reason, autoFiled: true, evidence: labels };
  }
  return {
    folder: 'tosort',
    suggestion: best,
    confidence: pct(bestScore),
    reason: signals.contentRead === false
      ? `PINIT couldn't read this file's contents. Best guess: ${FOLDER_LABEL[best]}`
      : `Not sure enough to file it. Best guess: ${FOLDER_LABEL[best]} (${reason})`,
    autoFiled: false,
    evidence: labels,
  };
}
