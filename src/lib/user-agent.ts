/**
 * What kind of device a request came from, in words a person would use: a phone, a tablet or a computer, with its
 * operating system and browser. Phone browsers hide the exact OS version, so only the system's name is reported.
 */
export type PinningDevice = {
  deviceType: 'Mobile phone' | 'Tablet' | 'Computer';
  os: string | null;
  browser: string | null;
};

export function describePinningDevice(userAgent?: string | null): PinningDevice | null {
  const ua = (userAgent ?? '').slice(0, 500);
  if (!ua.trim()) return null;

  const isTablet = /iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const isPhone = !isTablet && /iPhone|iPod|Android|Mobi/i.test(ua);
  const deviceType: PinningDevice['deviceType'] = isTablet ? 'Tablet' : isPhone ? 'Mobile phone' : 'Computer';

  const os = /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /CrOS/i.test(ua) ? 'ChromeOS'
    : /Linux/i.test(ua) ? 'Linux'
    : null;

  const browser = /SamsungBrowser/i.test(ua) ? 'Samsung Internet'
    : /EdgA?\/|Edge\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /Firefox|FxiOS/i.test(ua) ? 'Firefox'
    : /Chrome|CriOS/i.test(ua) ? 'Chrome'
    : /Safari/i.test(ua) ? 'Safari'
    : null;

  return { deviceType, os, browser };
}
