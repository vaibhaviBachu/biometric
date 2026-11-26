/**
 * Photos were piling up in To sort (production, 2026-11-20): text reading found "words" in a photo's texture, so a photo
 * scored as "an image with some text" (60%) or "a photo of a page" (50%), both under the 75% filing bar.
 * Pictures are now judged by real words only, and clear media types are filed straight away.
 */
import { classifyVaultFolder, realWordCount } from '../../src/lib/vault-folder-classifier';

const NOISE = 'ae | il ~ -= Ii 1l ,: oo :: rn mi ll1 ] [ ae ii .. io ue oa — = ~ 7 aa ee ii il li Il |l ae ;; ou ia';

const photo = (text: string, extra: Partial<Parameters<typeof classifyVaultFolder>[0]> = {}) =>
  classifyVaultFolder({ fileName: 'IMG_2294.jpeg', mimeType: 'image/jpeg', text, contentRead: true, ...extra });

describe('pictures are judged by real words, not texture noise', () => {
  test('noise from a photo is not counted as words', () => {
    expect(realWordCount(NOISE)).toBeLessThan(5);
    expect(realWordCount('Welcome to Charminar Hyderabad heritage walk')).toBe(5); // "to" is too short to count
    expect(realWordCount('आधार भारत सरकार 2345 6789 0124')).toBeGreaterThanOrEqual(3);
  });

  test('a photo whose text reading found only noise goes to Gallery', () => {
    const out = photo(`${NOISE} ${NOISE}`);
    expect(out).toMatchObject({ folder: 'gallery', autoFiled: true });
  });

  test('a WhatsApp photo with nothing to read goes to Gallery', () => {
    expect(classifyVaultFolder({ fileName: 'WhatsApp Image 2026-11-20 at 10.51.06.jpeg', mimeType: 'image/jpeg', text: '', contentRead: true }))
      .toMatchObject({ folder: 'gallery', autoFiled: true });
  });

  test('a photo of a sign or a menu (a few real words) goes to Gallery', () => {
    expect(photo('Hotel Paradise Biryani Menu Chicken Mutton Special Today Family Pack')).toMatchObject({ folder: 'gallery', autoFiled: true });
  });

  test('a photo of a page with nothing specific goes to Documents', () => {
    const page = 'Please find below the details of the meeting held on Monday regarding the community park cleanup drive and the volunteers who will join us next weekend for planting trees along the lake road near the temple';
    expect(photo(page)).toMatchObject({ folder: 'documents', autoFiled: true });
  });

  test('a photo of an Aadhaar card still goes to the private Identity folder', () => {
    const out = photo('Government of India Unique Identification Authority of India Test Person DOB 01/01/2000 FEMALE 2345 6789 0124');
    expect(out.folder).toBe('ids');
  });

  test('a UPI payment screenshot goes to the private Bank & Finance folder', () => {
    const out = classifyVaultFolder({
      fileName: 'Screenshot_20261120.png', mimeType: 'image/png', isScreenshot: true, contentRead: true,
      text: 'Payment successful Paid to Ravi Kumar UPI transaction id 432109876543 debited from HDFC Bank',
    });
    expect(out.folder).toBe('finance');
  });

  test('a course-completion certificate goes to Education', () => {
    const out = classifyVaultFolder({ fileName: 'certificate.pdf', mimeType: 'application/pdf', contentRead: true, text: 'This certificate of completion is awarded to Test Person for completing the Data Science course' });
    expect(out.folder).toBe('education');
  });

  test('a medical prescription goes to Documents', () => {
    const out = classifyVaultFolder({ fileName: 'scan.pdf', mimeType: 'application/pdf', contentRead: true, text: 'Patient name Test Person Diagnosis viral fever Prescription paracetamol twice daily for three days' });
    expect(out.folder).toBe('documents');
  });

  test('a screenshot full of app text (tabs, menus, buttons) goes to Gallery, not Documents', () => {
    const appText = 'File Edit View History Bookmarks Profiles Tab Window Help Home Search Explore Notifications Messages Settings Download Share Upload Gallery Photos Albums Library Favourites Recent Trash Account Privacy Security Language Display';
    const out = classifyVaultFolder({ fileName: 'Screenshot (316).png', mimeType: 'image/png', isScreenshot: true, contentRead: true, text: appText });
    expect(out).toMatchObject({ folder: 'gallery', autoFiled: true });
  });

  test('videos and audio are filed straight away', () => {
    expect(classifyVaultFolder({ fileName: 'trip.mp4', mimeType: 'video/mp4' })).toMatchObject({ folder: 'videos', autoFiled: true });
    expect(classifyVaultFolder({ fileName: 'voice-note.m4a', mimeType: 'audio/mp4' })).toMatchObject({ folder: 'audio', autoFiled: true });
  });
});
