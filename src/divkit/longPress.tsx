// The web's "right-click a link" menu, mobile-side, with an iOS haptic-touch feel.
// Long-pressing a navigable element opens a context menu you can slide onto and
// release to fire (or release in place and tap): Open it, copy its shareable web
// URL, or open that URL in the system browser. The web URL comes from
// `host.linkFor` — side-effect actions (post/delete/logout/theme) return null and
// get no menu, exactly like right-clicking a button vs. a link on the web.
//
// One continuous gesture drives the whole thing: a gesture-handler Pan that arms
// only after a long press (`activateAfterLongPress`) opens the overlay
// (../ui/contextMenu), feeds it the live finger position via `onUpdate` as it
// moves, and commits on release. Pan (not LongPress) so the finger-tracking comes
// from the reliable `onUpdate` stream — the same drag that opens the menu keeps
// driving the highlight, so sliding onto a row and releasing fires it, iOS-style.
// `runOnJS(true)` keeps the callbacks on the JS thread so they can drive the
// store directly.

import React, { useMemo } from 'react';
import { Linking, Share } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
  commitContextMenu,
  moveContextMenu,
  openContextMenu,
  type ContextMenuItem,
} from '../ui/contextMenu';
import { toast } from '../ui/toast';
import type { DivHost } from './types';

const EMPTY: ContextMenuItem[] = [];

// The full context menu for a long-pressed element: Open first (when the target is a
// navigable link), then any record `actions` the caller passes (a list row's post/edit/…),
// then the link utilities — Share, Copy link, Open in browser. An actions-only menu (no
// link) is allowed, so a row whose target isn't a link can still expose its actions.
function buildMenu(host: DivHost, url: string | undefined, extra: ContextMenuItem[]): ContextMenuItem[] {
  const link = url ? host.linkFor?.(url) : null;
  const items: ContextMenuItem[] = [];
  if (link && url) items.push({ label: 'Open', icon: 'arrow-up-right', onPress: () => host.fire(url) });
  items.push(...extra);
  if (link) {
    items.push(
      { label: 'Share', icon: 'share', onPress: () => { Share.share({ url: link, message: link }).catch(() => {}); } },
      { label: 'Copy link', icon: 'link', onPress: async () => { await Clipboard.setStringAsync(link); toast.success('Link copied'); } },
      { label: 'Open in browser', icon: 'external-link', onPress: () => { Linking.openURL(link).catch(() => toast.error("Couldn't open the link")); } },
    );
  }
  return items;
}

/** True when long-pressing `url` would offer a link menu — used to decide whether
 *  to wrap the element at all (so non-link actions keep their plain tap). */
export function hasLinkMenu(host: DivHost, url: string): boolean {
  return !!host.linkFor?.(url);
}

function buildGesture(host: DivHost, url: string | undefined, extra: ContextMenuItem[]) {
  return Gesture.Pan()
    .runOnJS(true)
    // Arm only after a deliberate ~300ms hold (a quick tap still navigates, a flick
    // still scrolls); activateAfterLongPress fires even without finger movement, so
    // the menu lifts in on the hold alone, exactly like an iOS haptic-touch press.
    .activateAfterLongPress(300)
    .maxPointers(1)
    .onStart((e) => {
      const items = buildMenu(host, url, extra);
      if (!items.length) return;
      // A firm tick on reveal, like iOS's own context menus.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      host.lockScroll?.(true); // freeze the page so the drag-to-select doesn't scroll it
      openContextMenu(items, { x: e.absoluteX, y: e.absoluteY }, () => host.lockScroll?.(false));
    })
    // The same press-and-drag keeps streaming here, so sliding onto a row highlights
    // it live (moveContextMenu no-ops when no menu is open, e.g. a non-link target).
    .onUpdate((e) => moveContextMenu(e.absoluteX, e.absoluteY))
    .onEnd(() => commitContextMenu());
}

/** Wrap a tappable element so a long-press opens its context menu — the link actions
 *  (Open / Share / Copy link / Open in browser) plus any `extraItems` (a row's record
 *  actions). Renders the child as-is when there's neither a link nor extra items (no
 *  gesture, no overhead). `children` must be a single native-backed element (a Pressable). */
export function ContextMenuArea({
  host,
  url,
  extraItems,
  children,
}: {
  host: DivHost;
  url?: string;
  extraItems?: ContextMenuItem[];
  children: React.ReactElement;
}) {
  const extra = extraItems ?? EMPTY;
  const enabled = (!!url && hasLinkMenu(host, url)) || extra.length > 0;
  const gesture = useMemo(() => (enabled ? buildGesture(host, url, extra) : null), [host, url, enabled, extra]);
  if (!gesture) return children;
  return <GestureDetector gesture={gesture}>{children}</GestureDetector>;
}
