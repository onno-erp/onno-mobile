// App-side palette for the custom widgets + chrome. The server-emitted DivKit
// cards already carry themed colors (light #FFFFFF/#0A0A0A → dark #121212/#EDEDED);
// these values harmonize the RN-drawn customs (cards, lists, forms) with them.
//
// The accent (primary / CTA buttons / highlights) is NOT fixed: each Onno server
// has its own brand color (vetovet = green, others = blue, …). `setBrand()` merges
// the server's `/api/branding` palette over these defaults on connect, so every
// `c.primary` / `c.accentBg` / `c.primarySoft` follows the deployment's brand.

export interface ThemeColors {
  bg: string;
  card: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  /** A soft tint of `primary` for pressed/selected backgrounds (row highlights, etc.). */
  primarySoft: string;
  fieldBg: string;
  fieldBorder: string;
  dangerBg: string;
  dangerFg: string;
  accentBg: string;
  accentFg: string;
  successBg: string;
  successFg: string;
}

// Alpha (8-digit hex suffix) for deriving `primarySoft` from a brand `primary` when
// the server doesn't ship an explicit soft slot — ~14%, subtle on light and dark.
const SOFT_ALPHA = '24';

const light: ThemeColors = {
  bg: '#FFFFFF',
  card: '#FFFFFF',
  surface: '#F9FAFB',
  border: '#E5E7EB',
  text: '#0A0A0A',
  muted: '#737373',
  primary: '#2563EB',
  primarySoft: '#2563EB24',
  fieldBg: '#FFFFFF',
  fieldBorder: '#D1D5DB',
  dangerBg: '#FEF2F2',
  dangerFg: '#B91C1C',
  // Primary action buttons (+New, Save, Edit, Send…) use the brand accent (defaults
  // to the Onno blue; overridden per-server by setBrand). accentBg is used only for these CTAs.
  accentBg: '#2563EB',
  accentFg: '#FFFFFF',
  successBg: '#DCFCE7',
  successFg: '#16A34A',
};

const dark: ThemeColors = {
  bg: '#121212',
  card: '#1B1B1B',
  surface: '#1B1B1B',
  border: '#2A2A2A',
  text: '#EDEDED',
  muted: '#808080',
  primary: '#3B82F6',
  primarySoft: '#3B82F624',
  fieldBg: '#1B1B1B',
  fieldBorder: '#3A3A3A',
  dangerBg: '#3A1414',
  dangerFg: '#F87171',
  accentBg: '#3B82F6',
  accentFg: '#FFFFFF',
  successBg: '#0F2A19',
  successFg: '#4ADE80',
};

/** The brand slots a Onno server can override (the shape of `/api/branding` palette.{light,dark}). */
export interface BrandPalette {
  page?: string;
  surface?: string;
  border?: string;
  text?: string;
  muted?: string;
  primary?: string;
  primarySoft?: string;
}

/** `color + alpha` if it's a `#RRGGBB` hex, else null (non-hex inputs can't take a hex alpha suffix). */
function softHex(c: string): string | null {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c + SOFT_ALPHA : null;
}

function applyBrand(base: ThemeColors, p?: BrandPalette): ThemeColors {
  if (!p || Object.keys(p).length === 0) return base;
  const primary = p.primary ?? base.primary;
  return {
    ...base,
    bg: p.page ?? base.bg,
    // The server's "surface" is the elevated/card background; map it to both.
    card: p.surface ?? base.card,
    surface: p.surface ?? base.surface,
    border: p.border ?? base.border,
    text: p.text ?? base.text,
    muted: p.muted ?? base.muted,
    primary,
    primarySoft: p.primarySoft ?? softHex(primary) ?? base.primarySoft,
    // The brand color is also the CTA fill (Save / +New / Add row).
    accentBg: p.primary ?? base.accentBg,
  };
}

// Current (possibly brand-merged) palettes. Start as the bare defaults; setBrand()
// rebuilds them. Kept as live singletons so isDark()'s reference check stays valid.
let lightC: ThemeColors = light;
let darkC: ThemeColors = dark;

/** Merge a server `/api/branding` palette over the defaults. Call once per connect. */
export function setBrand(palette: { light?: BrandPalette; dark?: BrandPalette } | null | undefined): void {
  lightC = applyBrand(light, palette?.light);
  darkC = applyBrand(dark, palette?.dark);
}

export function colors(theme: 'light' | 'dark'): ThemeColors {
  return theme === 'dark' ? darkC : lightC;
}

/** True when the palette is the dark one (reference equality against the current dark palette).
 *  Lets components pick theme-aware extras (e.g. shadow strength) from a `ThemeColors` alone. */
export function isDark(c: ThemeColors): boolean {
  return c === darkC;
}
