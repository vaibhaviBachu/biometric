/** A colour token backed by an RGB-channel CSS variable, so opacity modifiers (bg-x/40) keep working. */
const v = (name) => `rgb(var(${name}) / <alpha-value>)`;

/*
  Smoky Glass palette (design-reference/smoky-glass.html; tokens in src/styles/theme.css).
  Greys do the work, blue only points. Tailwind's cool hues are one electric-blue ramp, the greys one ash ramp,
  and the status hues (green, amber, yellow, orange) an ash "status" ramp: status is carried by a word and a shape,
  not by a colour. Red is the single alert colour. Every existing utility class lands inside the palette.
*/
const cobalt = {
  50: '#F1F2F5', 100: '#E6E8EC', 200: '#C5CCDC', 300: '#7BA2FF', 400: '#5585FF', 500: '#2F6BFF',
  600: '#2B62F0', 700: '#1F55E6', 800: '#24262C', 900: '#1B1D22', 950: '#131418',
};
const neutral = {
  50: '#F4F5F7', 100: '#E9EAED', 200: '#D9DBE0', 300: '#B9BCC4', 400: '#8E939E', 500: '#6B707B',
  600: '#4D515B', 700: '#3A3E47', 800: '#24262C', 900: '#17191E', 950: '#101114',
};
const status = {
  50: '#F1F2F5', 100: '#E6E8EC', 200: '#D0D3DA', 300: '#C4C7CF', 400: '#B9BCC4', 500: '#6B707B',
  600: '#3A3E47', 700: '#2B2E36', 800: '#24262C', 900: '#1B1D22', 950: '#131418',
};
const alert = {
  50: '#FBEEF0', 100: '#F7DDE0', 200: '#F0BEC4', 300: '#E8A0A8', 400: '#E8808B', 500: '#D95765',
  600: '#C8434F', 700: '#A93340', 800: '#882A35', 900: '#3E2227', 950: '#2A181B',
};

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: '1rem',
        sm: '1.25rem',
        lg: '1.5rem',
        xl: '2rem',
      },
      screens: {
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
        '2xl': '1400px',
      },
    },
    extend: {
      // Smoky glass — semantic values live as RGB channels in src/styles/theme.css
      colors: {
        // ── Surfaces ─────────────────────────────────────────────────────────
        bg: {
          base:     v('--c-bg-base'),
          surface:  v('--c-bg-surface'),
          card:     v('--c-bg-card'),
          elevated: v('--c-bg-elevated'),
          border:   v('--c-line'),
          muted:    v('--c-bg-surface'),
        },
        // ── Brand accent — electric blue (token name stays dna-*) ───────────
        dna: {
          50:  v('--c-lavender'),
          100: v('--c-periwinkle'),
          200: cobalt[200],
          300: cobalt[300],
          400: v('--c-brand-soft'),
          500: v('--c-brand'),
          600: v('--c-brand-press'),
          700: v('--c-brand-press'),
          800: cobalt[800],
          900: v('--c-fg'),
        },
        fg:      { DEFAULT: v('--c-fg'), 2: v('--c-fg-2'), muted: v('--c-fg-muted') },
        line:    { DEFAULT: v('--c-line'), control: v('--c-line-control') },
        // Pastel families: tint = surface, ink = text/icon on that tint
        lavender:   { DEFAULT: v('--c-lavender'),   ink: v('--c-lavender-ink') },
        periwinkle: { DEFAULT: v('--c-periwinkle'), ink: v('--c-periwinkle-ink') },
        powder:     { DEFAULT: v('--c-powder'),     ink: v('--c-powder-ink') },
        mint:       { DEFAULT: v('--c-mint'),       ink: v('--c-mint-ink') },
        peach:      { DEFAULT: v('--c-peach'),      ink: v('--c-peach-ink') },
        cream:      { DEFAULT: v('--c-cream'),      ink: v('--c-cream-ink') },
        rose:       { ...alert, DEFAULT: v('--c-rose'),       ink: v('--c-rose-ink') },
        alert:      { DEFAULT: v('--c-danger'),     ink: v('--c-danger-ink') },
        layer: {
          pending:    v('--c-fg-muted'),
          processing: v('--c-cream-ink'),
          complete:   v('--c-mint-ink'),
          failed:     v('--c-danger-ink'),
        },
        success: { DEFAULT: v('--c-mint-ink'),       light: v('--c-mint'),       dark: v('--c-mint-ink') },
        warning: { DEFAULT: v('--c-cream-ink'),      light: v('--c-cream'),      dark: v('--c-cream-ink') },
        danger:  { DEFAULT: v('--c-danger-ink'),     light: v('--c-danger'),     dark: v('--c-danger-ink') },
        info:    { DEFAULT: v('--c-periwinkle-ink'), light: v('--c-periwinkle'), dark: v('--c-fg') },
        purple:  { ...cobalt, DEFAULT: v('--c-lavender-ink'), light: v('--c-lavender'), dark: v('--c-fg') },
        cyan:    { ...cobalt, DEFAULT: v('--c-powder-ink'),   light: v('--c-powder'),   dark: v('--c-fg') },
        blue: cobalt, indigo: cobalt, sky: cobalt, violet: cobalt, fuchsia: cobalt, pink: cobalt, teal: cobalt,
        emerald: status, green: status, lime: status, amber: status, yellow: status,
        red: alert,
        slate: neutral, gray: neutral, zinc: neutral, neutral: neutral, stone: neutral,
        orange:  { ...status, DEFAULT: v('--c-peach-ink'),      light: v('--c-peach'),      dark: v('--c-peach-ink') },
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        display: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        label: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        editorial: ['Source Serif 4', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        chip: '10px',
        control: '12px',
        card: '16px',
        panel: '22px',
      },
      transitionTimingFunction: {
        soft: 'cubic-bezier(0.22, 1, 0.36, 1)',
        exit: 'cubic-bezier(0.55, 0, 0.75, 0.06)',
      },
      fontSize: {
        '2xs': ['0.7rem', { lineHeight: '1rem' }],
      },
      animation: {
        'pulse-slow':    'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow':     'spin 3s linear infinite',
        'fade-in':       'fadeIn 0.2s ease-out',
        'slide-in-left': 'slideInLeft 0.25s ease-out',
        'shimmer':       'shimmer 1.5s infinite',
        'float':         'float 6s ease-in-out infinite',
        'rise-in':       'riseIn 0.38s cubic-bezier(0.22, 1, 0.36, 1) backwards',
      },
      keyframes: {
        float:       { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-6px)' } },
        riseIn:      { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'none' } },
        fadeIn:      { from: { opacity: '0' }, to: { opacity: '1' } },
        slideInLeft: { from: { opacity: '0', transform: 'translateX(-12px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        shimmer:     { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
      },
      boxShadow: {
        'glow-purple': '0 0 0 1px rgba(47,107,255,0.5), 0 8px 20px -10px rgba(47,107,255,0.7)',
        'glow-green':  '0 0 0 1px rgba(134,138,149,0.35)',
        'glow-red':    '0 0 0 1px rgba(200,67,79,0.45)',
        // Elevation, per theme (src/styles/theme.css)
        'elev-1': 'var(--shadow-e1)',
        'elev-2': 'var(--shadow-e2)',
        'elev-3': 'var(--shadow-e3)',
        'btn-primary': 'var(--shadow-btn)',
      },
    },
  },
  plugins: [],
};
