# PinITHUB design system — v4 "Cobalt Helix"

Status: **implemented** (2026-10-31). Supersedes the pastel (v2) and lavender-blue (v3) plans.

Brand palette, three colours only:

| Role | Value |
|---|---|
| Black | `#000000` (canvas `#05060B`, a black with a faint cobalt cast) |
| Deep cobalt | `#2C3480` |
| White | `#FFFFFF` |

Everything else is a tint, shade or opacity of those three. Green / amber / red appear only where they
carry status meaning (success, warning, danger). The PinITHUB logo is never redrawn or replaced.

---

## 1. How it is wired

| Layer | File | What it does |
|---|---|---|
| Theme switch | `client/index.html` (`<html class="dark">`), `hooks/useTheme.ts` | One theme. The `dark` class is always on, so the app's existing global dark layer is the base. |
| Global dark layer | `client/src/index.css` | The app's own dark rules (remaps of `bg-white`, `text-slate-900` …). Light-only colour declarations were moved under `html:not(.dark)`; every cool hue was shifted onto the cobalt hue. |
| Brand layer | `client/src/styles/theme.css` (imported after `index.css`) | Tokens, canvas, DNA backdrop scrims, cards, buttons, forms, tables, menus, sidebar, header, mobile nav, page band, auth. |
| Tailwind | `client/tailwind.config.js` | `blue / indigo / sky / violet / purple / fuchsia / pink / cyan` → one **cobalt ramp**; `slate / gray / zinc / neutral / stone` → a **cobalt-cast neutral ramp**. Every existing utility class lands inside the palette without page edits. Semantic tokens (`bg-*`, `fg-*`, `dna-*`, families) read RGB-channel CSS variables. |
| DNA backdrop | `components/dna/DnaBackdrop.tsx`, `components/dna/dnaRenderer.ts` | The signature 3D helix behind every page (§4). |

### Cobalt ramp (Tailwind `blue-*` etc.)

50 `#EEF0FB` · 100 `#DDE1F7` · 200 `#BEC4EE` · 300 `#9AA3E3` · 400 `#7B85D9` · 500 `#5A64C6` ·
600 `#434DAE` · 700 `#363F97` · **800 `#2C3480`** · 900 `#222868` · 950 `#141838`

### Neutral ramp (Tailwind `slate-*` etc.)

50 `#F6F7FA` · 100 `#ECEEF4` · 200 `#D9DCE7` · 300 `#BABFD2` · 400 `#9298B2` · 500 `#7A80A0` ·
600 `#555B78` · 700 `#3A3F58` · 800 `#23273B` · 900 `#13162A` · 950 `#07080F`

## 2. Tokens

| Token | Value | Use |
|---|---|---|
| `--c-bg-base` | `#05060B` | canvas |
| `--c-bg-surface` | `#0B0D18` | recessed areas |
| `--c-bg-card` | `#0D0F1C` | cards (opaque — the DNA never sits under text) |
| `--c-bg-elevated` | `#14172A` | menus, raised chips |
| `--c-fg` / `-2` / `-muted` | `#FFFFFF` / `#CDD1E2` / `#9298B6` | text; muted is the smallest allowed (6.6:1) |
| `--c-line` | `#23273B` | hairlines |
| `--c-brand` | `#2C3480` | primary buttons, active nav (white label 11.6:1) |
| `--c-brand-soft` | `#7B85D9` | cobalt *as text or icon* on black (5.6:1); raw `#2C3480` is never text on black |

Radii: chip 8 · control 10 · card 14 · panel 18. Motion: 120 / 200 / 320 ms, ease-out `cubic-bezier(0.22,1,0.36,1)`; reduced motion removes all of it.

## 3. Components

- **Sidebar**: black falling into deep cobalt at the foot. Labels `#CDD1E2`, group labels `#7A80A0`, icons `#9298B6`. Active item: solid cobalt with a 3px white bar at the left edge. Hover: 5% white.
- **Header**: black glass (72%, blur 20) with a white 7% hairline.
- **Mobile nav**: floating black glass capsule; the active tab's icon sits on a cobalt pill.
- **Cards**: opaque `#0D0F1C`, 7% white border, faint top light. Hover lifts the border to cobalt 32%. `.surface-feature` (cobalt light from the top-left) is for one hero per page only.
- **Buttons**: primary = cobalt with a lit top edge; secondary = black with a white hairline; `btn-light` = white with black text (strongest call-out, use sparingly); ghost; danger = dark red tint with light red text.
- **Forms**: `#07080F` wells, `#262A40` border, focus = `#7B85D9` border + cobalt 30% ring.
- **Tables**: uppercase 11px headers on `#0A0C17`; row hover = cobalt 16%.
- **Modals / menus**: `#0B0D1A` / 96% black glass, 9–10% white border, deep shadow; backdrop black 65%.
- **Icon tiles** (`.stat-icon-*`, `.gem-*`): metallic cobalt, midnight, steel and pearl.
- **PageHeader** (`components/ui/PageHeader.tsx`): black glass band lit by cobalt from the top-left.

## 4. The DNA backdrop

A lit 3D double helix painted on a fixed canvas behind the app (`z-index:-1`, `pointer-events:none`):

- Glossy metal: cobalt strand + silver strand made of dense overlapping shaded spheres (specular
  highlight, dark edge, cobalt rim light), translucent base-pair cylinders, the real major/minor groove
  offset, perspective and painter's-order depth sorting.
- Depth of field: blurred copy everywhere, sharp copy masked to the middle of the axis.
- Atmosphere: cobalt light pool behind the helix; sparse out-of-focus particles.
- **Placement per area** (Home, Pin It, My Work, Storage Health, Share, Prove, Grow, Account, Business,
  sign-in, public pages) so pages don't repeat. Left-side placements start at x ≥ 0.3 to clear the sidebar.
- **Readability**: a scrim gradient darkest where text sits (mirrored for left-side helices), cards are
  opaque, and phones get a 50% flat scrim with the helix pushed to the right edge.
- **Performance**: no images, no WebGL, no dependency. One paint per area or resize (DPR capped at 1.5),
  deferred off the first frame, fades in over 600 ms.

## 5. Rules

1. Only black, cobalt, white and their tints. Status colours only for status.
2. Cobalt text on black uses `#7B85D9`–`#9AA3E3`, never `#2C3480`.
3. Glass is for the header, menus, page bands and the sign-in card — not for every card.
4. No glows, floating orbs or gradient text. Page titles 22–26px, weight 700.
5. Every text pairing ≥ 4.5:1 (≥ 3:1 for large text). The preview audit checks every route.
