/** Product branding — PinITHUB (replaces legacy PINIT-DNA shell labels). */
export const BRAND = {
  name: 'PinITHUB',
  tagline: 'Secure · Connect · Control',
  version: 'v2.0 · Universal',
  logoSrc: '/pinithub-logo.png',        // full logo with name and tagline (light background)
  /** Round emblem on its own (transparent background) — the sidebar mark. */
  emblemSrc: '/pinit-hub-emblem-cut.png',
  /** Primary investigation route (replaces /unified-investigation). */
  investigationPath: '/pinit-hub/investigation',
} as const;
