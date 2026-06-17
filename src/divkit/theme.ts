// App-side palette for the custom widgets + chrome. The server-emitted DivKit
// cards already carry themed colors (light #FFFFFF/#0A0A0A → dark #121212/#EDEDED);
// these values harmonize the RN-drawn customs (cards, lists, forms) with them.

export interface ThemeColors {
  bg: string;
  card: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  fieldBg: string;
  fieldBorder: string;
  dangerBg: string;
  dangerFg: string;
  accentBg: string;
  accentFg: string;
  successBg: string;
  successFg: string;
}

const light: ThemeColors = {
  bg: '#FFFFFF',
  card: '#FFFFFF',
  surface: '#F9FAFB',
  border: '#E5E7EB',
  text: '#0A0A0A',
  muted: '#737373',
  primary: '#2563EB',
  fieldBg: '#FFFFFF',
  fieldBorder: '#D1D5DB',
  dangerBg: '#FEF2F2',
  dangerFg: '#B91C1C',
  accentBg: '#111827',
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
  fieldBg: '#1B1B1B',
  fieldBorder: '#3A3A3A',
  dangerBg: '#3A1414',
  dangerFg: '#F87171',
  accentBg: '#EDEDED',
  accentFg: '#121212',
  successBg: '#0F2A19',
  successFg: '#4ADE80',
};

export function colors(theme: 'light' | 'dark'): ThemeColors {
  return theme === 'dark' ? dark : light;
}
