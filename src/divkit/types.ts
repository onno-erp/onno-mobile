// A pragmatic subset of the DivKit JSON schema — only the fields the Onno
// server emits for the mobile viewport. Everything is loose (`any`-ish) on
// purpose: the document is server-driven and we resolve expressions at runtime.

export interface DivCardEnvelope {
  templates?: Record<string, DivBlock>;
  card: DivCard;
}

export interface DivCard {
  log_id?: string;
  variables?: DivVariable[];
  states: DivCardState[];
}

export interface DivCardState {
  state_id: number;
  div: DivBlock;
}

export interface DivVariable {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'color' | 'url' | 'dict' | 'array';
  name: string;
  value: unknown;
}

export interface DivAction {
  log_id?: string;
  url?: string;
  /** nested actions / payload — passed through to the host */
  [k: string]: unknown;
}

// A block is any object with a `type`. We keep it open-ended.
export interface DivBlock {
  type: string;
  // common
  action?: DivAction;
  actions?: DivAction[];
  paddings?: DivEdge;
  margins?: DivEdge;
  width?: DivSize;
  height?: DivSize;
  background?: DivBackground[];
  border?: { corner_radius?: number; stroke?: { color?: string; width?: number } };
  alpha?: number;
  visibility?: 'visible' | 'invisible' | 'gone' | string;
  alignment_horizontal?: string;
  alignment_vertical?: string;
  // container
  orientation?: 'vertical' | 'horizontal' | 'overlap';
  items?: DivBlock[];
  content_alignment_horizontal?: string;
  content_alignment_vertical?: string;
  // text
  text?: string;
  font_size?: number;
  font_weight?: string;
  text_color?: string;
  text_alignment_horizontal?: string;
  max_lines?: number;
  // image
  image_url?: string;
  // gallery
  // grid
  column_count?: number;
  // separator
  delimiter_style?: { color?: string; orientation?: string };
  // custom
  custom_type?: string;
  custom_props?: Record<string, unknown>;
  items_custom?: DivBlock[]; // div-custom child items (rarely used here)
  // template extension
  $templates_applied?: boolean;
  [k: string]: unknown;
}

export interface DivEdge {
  top?: number; bottom?: number; left?: number; right?: number;
  start?: number; end?: number; horizontal?: number; vertical?: number;
}

export type DivSize =
  | { type: 'fixed'; value?: number; unit?: string }
  | { type: 'wrap_content'; constrained?: boolean }
  | { type: 'match_parent'; weight?: number };

export interface DivBackground {
  type: 'solid' | string;
  color?: string;
}

/** A custom-widget renderer registered for an `onno-*` custom_type. */
export type CustomRenderer = (props: {
  block: DivBlock;
  customProps: Record<string, unknown>;
  host: DivHost;
}) => React.ReactNode;

/** Everything a card/custom widget needs from the embedding app. */
export interface DivHost {
  /** Dispatch an `onno://…` (or `div-action://…`) action url. */
  fire: (url: string) => void;
  /** Warm the cache for a nav destination on touch-down (best-effort; a no-op for
   *  non-navigation actions), so the screen is ready by the time the tap lands. */
  prefetch?: (url: string) => void;
  /** The shareable web URL an `onno://…` navigation maps to (origin + path), used
   *  by the long-press "Copy link / Open in browser" menu. Returns null for
   *  side-effect actions (post/delete/logout/theme) — those aren't links. */
  linkFor?: (url: string) => string | null;
  /** Read/patch card variables. */
  getVar: (name: string) => unknown;
  setVar: (name: string, value: unknown) => void;
  /** Reload the current surface after a write (post/save/delete). */
  refresh: () => void;
  /** Present when this card is an embedded create form opened from a reference picker.
   *  On a successful create the form calls this with the saved row (instead of
   *  navigating to its detail), so the picker can select it and close the overlay. */
  onCreated?: (row: Record<string, any>) => void;
  /** The API client, for data-driven customs (list/widget/form/comments). */
  client: import('../api/onnoClient').OnnoClient;
  /** Origin used to absolutize relative image urls. */
  baseUrl?: string;
  theme: 'light' | 'dark';
  /** Lock/unlock the surrounding scroll surface while a child drives its own pan
   *  gesture (maps) — RN's ScrollView won't otherwise yield to a JS PanResponder. */
  lockScroll?: (locked: boolean) => void;
}
