import {
  AUTO_FILE_CONFIDENCE,
  classifyVaultFolder,
  isPrivateVaultFolder,
  isValidAadhaarNumber,
  type FolderSignals,
} from '../../src/lib/vault-folder-classifier';
import { isExposurePrivate, isOwnerLocked, notExposurePrivateWhere } from '../../src/lib/vault-folder-privacy';
import { keepCurrentFolder } from '../../src/services/vault/vault-classification.service';
import {
  issuePrivateUnlockToken,
  verifyPrivateUnlockToken,
} from '../../src/services/vault/private-folder-unlock.service';

const pdf = (fileName: string, text: string, extra: Partial<FolderSignals> = {}): FolderSignals => ({
  fileName, mimeType: 'application/pdf', text, contentRead: true, ...extra,
});

// A syntactically valid Aadhaar number (Verhoeff check digit), not a real person's.
const SAMPLE_AADHAAR = '234123412346';

describe('Aadhaar number check', () => {
  it('accepts a number with a valid check digit and rejects others', () => {
    expect(isValidAadhaarNumber(SAMPLE_AADHAAR)).toBe(true);
    expect(isValidAadhaarNumber('234123412345')).toBe(false);
    expect(isValidAadhaarNumber('123412341234')).toBe(false); // cannot start with 1
  });
});

describe('sensitive files', () => {
  it.each([
    ['Aadhaar letter', pdf('scan.pdf', 'Government of India  Unique Identification Authority of India  Aadhaar')],
    ['Aadhaar number only', pdf('doc.pdf', `Name Ashwitha  DOB 01/01/2000  ${SAMPLE_AADHAAR.replace(/(\d{4})(?=\d)/g, '$1 ')}`)],
    ['PAN card', { fileName: 'IMG_1001.jpg', mimeType: 'image/jpeg', text: 'INCOME TAX DEPARTMENT  Permanent Account Number Card  ABCPE1234F', contentRead: true }],
    ['passport MRZ', pdf('travel.pdf', 'P<INDREDDY<<ASHWITHA<<<<<<<<<<<<<<<<<<<<<<<<')],
    ['voter ID', pdf('card.pdf', 'ELECTION COMMISSION OF INDIA  Elector Photo Identity Card')],
    ['government certificate', pdf('cert.pdf', 'This is to certify ... Income Certificate issued by the Tahsildar')],
  ])('%s goes to Identity & IDs', (_label, signals) => {
    const d = classifyVaultFolder(signals as FolderSignals);
    expect(d.folder).toBe('ids');
    expect(d.autoFiled).toBe(true);
    expect(d.confidence).toBeGreaterThanOrEqual(AUTO_FILE_CONFIDENCE * 100);
  });

  it.each([
    ['bank statement', pdf('export.pdf', 'State Bank of India  Account Statement  Opening Balance 1,200.00  Closing Balance 900.00')],
    ['payslip with an employee number', pdf('oct.pdf', 'Salary Slip for October  Employee No 4411  Gross Salary 50,000  Net Pay 44,000')],
    ['UPI screenshot', { fileName: 'Screenshot_2026.png', mimeType: 'image/png', isScreenshot: true, text: 'Payment Successful  Paid to Ravi  UPI transaction ID 123456789012', contentRead: true }],
    ['Form 16', pdf('f.pdf', 'FORM 16  Certificate under section 203 of the Income-tax Act  Tax deducted at source')],
    ['bank statement that also prints a PAN', pdf('stmt.pdf', 'HDFC Bank Account Statement  Opening Balance  Closing Balance  PAN ABCPE1234F')],
  ])('%s goes to Bank & Finance', (_label, signals) => {
    expect(classifyVaultFolder(signals as FolderSignals).folder).toBe('finance');
  });

  it('files an unreadable scan named like an Aadhaar straight into Identity & IDs', () => {
    for (const name of ['ashwitha_adhar.pdf', 'Aadhar Card.pdf', 'my-aadhaar.pdf', 'adhaar_scan.pdf']) {
      const d = classifyVaultFolder({ fileName: name, mimeType: 'application/pdf', contentRead: false });
      expect(d.folder).toBe('ids');
      expect(d.autoFiled).toBe(true);
    }
  });

  it('still asks when the name says Aadhaar but the contents firmly say something else', () => {
    const d = classifyVaultFolder(pdf('aadhaar_notes.pdf', 'Statement of Marks  Semester VI  SGPA 8.4  Osmania University'));
    expect(d.folder).toBe('tosort');
    expect(d.suggestion).toBe('ids');
  });
});

describe('files that were sent to To sort before', () => {
  it.each([
    ['uploaded phone photo flagged as a screenshot', { fileName: 'Temple.jpeg', mimeType: 'image/jpeg', isScreenshot: true, text: '', contentRead: true }, 'gallery'],
    ['webp image with no words', { fileName: 'aasset 1.webp', mimeType: 'image/webp', text: '', contentRead: true }, 'gallery'],
    ['photo too large to read', { fileName: 'test_image_45mb.jpg', mimeType: 'image/jpeg', contentRead: false }, 'gallery'],
    ['resume that mentions a university', pdf('Ashritha_resume (5).pdf', 'Education  B.Tech  JNTU University  Semester 8  Skills  Projects  Internship  Experience'), 'work'],
  ])('%s', (_label, signals, expected) => {
    expect(classifyVaultFolder(signals as FolderSignals).folder).toBe(expected);
  });
});

describe('everyday folders', () => {
  it.each([
    ['marksheet', pdf('result.pdf', 'Statement of Marks  Semester VI  SGPA 8.4  Osmania University'), 'education'],
    ['admit card', pdf('a.pdf', 'Hall Ticket  Roll No 1234  Examination Centre: Hyderabad'), 'education'],
    ['research paper', pdf('paper.pdf', 'Abstract  We propose ...  Introduction ...  References  [1] doi:10.1000/xyz'), 'education'],
    ['resume', pdf('Ashwitha.pdf', 'Curriculum Vitae  Work Experience  Skills  B.Tech, JNTU University'), 'work'],
    ['offer letter', pdf('letter.pdf', 'Offer Letter  We are pleased to offer you ... Annual CTC'), 'work'],
    ['prescription', pdf('rx.pdf', 'Patient Name: A Reddy  Diagnosis: fever  Prescription: paracetamol'), 'documents'],
    ['boarding pass', pdf('trip.pdf', 'Boarding Pass  PNR AB12CD  Flight No 6E 123'), 'documents'],
    ['rental agreement', pdf('house.pdf', 'This rental agreement is made between the landlord and the tenant hereinafter'), 'documents'],
    ['other readable document', pdf('notes-random.pdf', 'Shopping ideas for the weekend market with friends and family around town'), 'documents'],
  ])('%s', (_label, signals, expected) => {
    expect(classifyVaultFolder(signals).folder).toBe(expected);
  });

  it.each([
    ['audio', { fileName: 'Voice_note.m4a', mimeType: 'audio/mp4', contentRead: true }, 'audio'],
    ['camera video', { fileName: 'trip.mp4', mimeType: 'video/mp4', captureMethod: 'PinIT Video Capture', contentRead: true }, 'videos'],
    ['uploaded video', { fileName: 'WhatsApp Video 2026-10-27.mp4', mimeType: 'video/mp4', captureMethod: 'Upload', contentRead: true }, 'videos'],
    ['camera photo with no text', { fileName: 'IMG_2041.jpg', mimeType: 'image/jpeg', captureMethod: 'PinIT Camera', text: '', contentRead: true }, 'gallery'],
    ['uploaded photo with no text', { fileName: 'holiday.jpg', mimeType: 'image/jpeg', captureMethod: 'Upload', text: '', contentRead: true }, 'gallery'],
    ['design file', { fileName: 'poster.psd', mimeType: 'image/vnd.adobe.photoshop', contentRead: true }, 'work'],
    ['code archive', { fileName: 'project-src.zip', mimeType: 'application/zip', contentRead: true }, 'work'],
  ])('%s', (_label, signals, expected) => {
    expect(classifyVaultFolder(signals as FolderSignals).folder).toBe(expected);
  });
});

describe('misleading file names', () => {
  it('reads an Aadhaar card named like a holiday photo as an ID', () => {
    const d = classifyVaultFolder({
      fileName: 'holiday_photo.jpg',
      mimeType: 'image/jpeg',
      text: 'Government of India  Unique Identification Authority of India  Aadhaar  DOB',
      contentRead: true,
    });
    expect(d.folder).toBe('ids');
  });

  it('sends a "marksheet" that is really an Aadhaar card to To sort with the private guess', () => {
    const d = classifyVaultFolder(pdf('marksheet.pdf', 'Unique Identification Authority of India  Aadhaar  enrolment no'));
    expect(d.folder).toBe('tosort');
    expect(d.suggestion).toBe('ids');
    expect(d.reason).toMatch(/file name suggests Education/);
  });

  it('never files a photo named "aadhaar" into Gallery just because it is a photo — it stays private', () => {
    const d = classifyVaultFolder({ fileName: 'aadhaar.jpg', mimeType: 'image/jpeg', captureMethod: 'PinIT Camera', text: '', contentRead: true });
    expect(d.folder).toBe('ids');
  });
});

describe('mixed and uncertain content', () => {
  it('a form that only mentions Aadhaar is not filed automatically, but its guess stays private', () => {
    const d = classifyVaultFolder(pdf('form.pdf', 'University admission form. Please attach a copy of your Aadhaar with this form.'));
    expect(d.folder).toBe('tosort');
    expect(d.suggestion).toBe('ids');
    expect(d.autoFiled).toBe(false);
  });

  it('a clear marksheet that also contains identity details goes to To sort with the private guess', () => {
    const d = classifyVaultFolder(pdf('marks.pdf', 'Statement of Marks  Semester IV  SGPA 9.1  Grade card  Transcript  Aadhaar'));
    expect(d.folder).toBe('tosort');
    expect(d.suggestion).toBe('ids');
  });

  it('an unreadable scanned document goes to To sort with a low confidence', () => {
    const d = classifyVaultFolder({ fileName: 'scan_0031.pdf', mimeType: 'application/pdf', contentRead: false });
    expect(d.folder).toBe('tosort');
    expect(d.confidence).toBeLessThan(AUTO_FILE_CONFIDENCE * 100);
  });

  it('a PNG with no text and no camera details is filed in Gallery (the owner can move it)', () => {
    const d = classifyVaultFolder({ fileName: 'export.png', mimeType: 'image/png', text: '', contentRead: true });
    expect(d.folder).toBe('gallery');
    expect(d.autoFiled).toBe(true);
  });

  it('never puts file text into the evidence it returns', () => {
    const d = classifyVaultFolder(pdf('x.pdf', `Aadhaar ${SAMPLE_AADHAAR} Ashwitha Reddy`));
    expect(JSON.stringify(d)).not.toContain(SAMPLE_AADHAAR);
    expect(JSON.stringify(d)).not.toContain('Ashwitha');
  });
});

describe('privacy rules', () => {
  it('locks private folders and To sort files with a private guess', () => {
    expect(isOwnerLocked({ folder: 'ids' })).toBe(true);
    expect(isOwnerLocked({ folder: 'tosort', folderSuggestion: 'finance' })).toBe(true);
    expect(isOwnerLocked({ folder: 'tosort', folderSuggestion: 'education' })).toBe(false);
    expect(isOwnerLocked({ folder: 'gallery' })).toBe(false);
  });

  it('keeps files still being read off public places', () => {
    expect(isExposurePrivate({ folder: null, folderStatus: 'pending' })).toBe(true);
    expect(isExposurePrivate({ folder: 'gallery', folderStatus: 'auto_filed' })).toBe(false);
    expect(isExposurePrivate({ folder: null, folderStatus: null })).toBe(false);
  });

  it('spells out NULLs in the public-places filter', () => {
    const json = JSON.stringify(notExposurePrivateWhere());
    expect(json).toContain('{"folder":null}');
    expect(json).toContain('{"folderStatus":null}');
    expect(json).toContain('{"folderSuggestion":null}');
  });

  it('marks only IDs and finance as private folders', () => {
    expect(isPrivateVaultFolder('ids')).toBe(true);
    expect(isPrivateVaultFolder('finance')).toBe(true);
    expect(isPrivateVaultFolder('education')).toBe(false);
    expect(isPrivateVaultFolder(null)).toBe(false);
  });
});

describe('keepCurrentFolder', () => {
  it('never auto-moves a file out of a private folder', () => {
    expect(keepCurrentFolder('ids', 'documents')).toBe(true);
    expect(keepCurrentFolder('finance', 'gallery')).toBe(true);
  });
  it('allows a move between private folders and from generic to specific', () => {
    expect(keepCurrentFolder('finance', 'ids')).toBe(false);
    expect(keepCurrentFolder('documents', 'education')).toBe(false);
    expect(keepCurrentFolder('gallery', 'videos')).toBe(false);
  });
  it('never falls back from a specific folder to a generic one', () => {
    expect(keepCurrentFolder('education', 'documents')).toBe(true);
    expect(keepCurrentFolder('gallery', 'tosort')).toBe(true);
  });
});

describe('private unlock token', () => {
  it('verifies for the same user before it expires', () => {
    const now = Date.now();
    const { token } = issuePrivateUnlockToken('user-1', now);
    expect(verifyPrivateUnlockToken(token, 'user-1', now + 60_000)).toBe(true);
  });
  it('rejects another user, an expired token and a tampered token', () => {
    const now = Date.now();
    const { token } = issuePrivateUnlockToken('user-1', now);
    expect(verifyPrivateUnlockToken(token, 'user-2', now)).toBe(false);
    expect(verifyPrivateUnlockToken(token, 'user-1', now + 11 * 60_000)).toBe(false);
    expect(verifyPrivateUnlockToken(`${token}x`, 'user-1', now)).toBe(false);
    expect(verifyPrivateUnlockToken(undefined, 'user-1', now)).toBe(false);
  });
});
