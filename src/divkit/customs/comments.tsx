// onno-comments — a per-record discussion thread. custom_props.target =
// { kind, name, id }; the widget loads/posts from /api/comments/... It mirrors the
// web entity-comments-widget: a card with the thread listed above an inline
// composer (input + Send side by side), author avatars, and relative timestamps.
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { Row } from '../../api/onnoClient';
import { onUiEvent } from '../../api/events';
import { colors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';
import { LucideIcon } from './lucide';
import { Touchable } from '../../ui/touchable';

// Up to two initials from a display name, for the author avatar fallback.
function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// A compact "time ago" for recent comments, falling back to an absolute date for
// older ones. createdAt is a server LocalDateTime (no zone), read in local time.
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return 'just now';
  if (secs < 90) return 'a minute ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function Avatar({ url, name, c }: { url?: string | null; name?: string | null; c: ReturnType<typeof colors> }) {
  const size = 30;
  const base = { width: size, height: size, borderRadius: size / 2 } as const;
  if (url) return <Image source={{ uri: url }} style={[base, { backgroundColor: c.surface }]} />;
  return (
    <View style={[base, { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={{ fontSize: 11, fontWeight: '600', color: c.muted }}>{initials(name)}</Text>
    </View>
  );
}

// A stored mention token `@[Display](kind/name/id)` (mirrors the server's Mentions syntax), so a
// mentioned record round-trips and renders as a tappable onno:// route.
const MENTION_TOKEN =
  /@\[([^\]]+)\]\((catalogs|documents)\/([^/)\s]+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

type Pick = { display: string; kind: string; name: string; id: string };

// The composer holds clean `@Display` text + the picks chosen; at send time each pick's first
// `@Display` run is rewritten to its full token so the server stores the route triple.
function toTokenBody(text: string, picks: Pick[]): string {
  let out = text;
  for (const p of picks) {
    const needle = `@${p.display}`;
    const at = out.indexOf(needle);
    if (at < 0) continue;
    const token = `@[${p.display.replace(/]/g, '')}](${p.kind}/${p.name}/${p.id})`;
    out = out.slice(0, at) + token + out.slice(at + needle.length);
  }
  return out;
}

// The `@query` run just before the caret (empty right after `@`), or null when the caret isn't
// in a mention context — a mention starts at line-start or after whitespace and runs to the caret.
function activeMentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { query: m[1], start: before.length - m[1].length - 1 };
}

// Render a comment body: mention tokens become tappable @links (open the record), the runs
// between them stay plain text.
function renderBody(body: string, host: DivHost, c: ReturnType<typeof colors>): React.ReactNode {
  const re = new RegExp(MENTION_TOKEN);
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index > last) out.push(body.slice(last, m.index));
    const [, display, mkind, mname, mid] = m;
    out.push(
      <Text key={`m${key++}`} style={{ color: c.primary, fontWeight: '500' }} onPress={() => host.fire(`onno://${mkind}/${mname}/${mid}`)}>
        @{display}
      </Text>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}

function Comments({ target, host }: { target: Record<string, any>; host: DivHost }) {
  const c = colors(host.theme);
  const kind = (target.kind as string) ?? '';
  const name = (target.name as string) ?? '';
  const id = (target.id as string) ?? '';
  const [comments, setComments] = useState<Row[] | null>(null);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  // @-mention compose state: clean `@Display` text in `text`, the chosen records in `picks`,
  // the active `@query` in `mq`, and its live suggestions. Refs track the latest text + caret
  // so the once-bound handlers read current values.
  const [picks, setPicks] = useState<Pick[]>([]);
  const [mq, setMq] = useState<{ query: string; start: number } | null>(null);
  const [suggestions, setSuggestions] = useState<Row[]>([]);
  const [composing, setComposing] = useState(false); // the keyboard-anchored compose overlay is open
  const textRef = useRef(text);
  textRef.current = text;
  const caretRef = useRef(0);
  const reqSeq = useRef(0);

  async function load() {
    try {
      setComments(await host.client.comments(kind, name, id));
    } catch {
      setComments([]);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, name, id]);

  // Live-sync: the server stamps a comment post/delete as an EntityChangedEvent
  // (entityType "comment", scoped to this record's name+id) on the same SSE stream.
  // Refetch the thread when one matches, so other viewers' posts/deletes appear without
  // a reload. The viewer's own write already showed optimistically — this reconciles it.
  useEffect(() => {
    return onUiEvent((ev) => {
      if (ev.entityType === 'comment' && String(ev.id) === String(id) && ev.entityName === name) load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, name, id]);

  // Debounced @-mention typeahead while a mention query is active; stale responses ignored.
  useEffect(() => {
    if (mq === null) {
      setSuggestions([]);
      return;
    }
    const seq = ++reqSeq.current;
    const t = setTimeout(() => {
      host.client
        .searchMentions(mq.query)
        .then((rows) => { if (seq === reqSeq.current) setSuggestions(rows); })
        // Mentions disabled (404) / any failure → no suggestions; the box still posts plain text.
        .catch(() => { if (seq === reqSeq.current) setSuggestions([]); });
    }, 160);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mq]);

  const onChangeText = (t: string) => {
    textRef.current = t;
    setText(t);
    setMq(activeMentionQuery(t, t.length)); // optimistic (caret ≈ end); onSelectionChange refines
  };
  const onSelectionChange = (e: { nativeEvent?: { selection?: { start?: number } } }) => {
    const car = e?.nativeEvent?.selection?.start ?? textRef.current.length;
    caretRef.current = car;
    setMq(activeMentionQuery(textRef.current, car));
  };
  // Insert a chosen suggestion: replace the active `@query` run with clean `@Display `, record the
  // pick (serialized to its token at send), and close the picker.
  const choose = (s: Row) => {
    const ctx = mq ?? activeMentionQuery(textRef.current, caretRef.current);
    if (!ctx) return;
    const display = String(s.display ?? '');
    const t = textRef.current;
    const end = Math.max(ctx.start, Math.min(caretRef.current, t.length));
    const newText = t.slice(0, ctx.start) + `@${display} ` + t.slice(end);
    textRef.current = newText;
    setText(newText);
    setPicks((prev) => [...prev, { display, kind: String(s.kind), name: String(s.name), id: String(s.id) }]);
    setMq(null);
    setSuggestions([]);
  };

  async function send() {
    const raw = text.trim();
    if (!raw || posting) return;
    setPosting(true);
    try {
      const saved = await host.client.addComment(kind, name, id, toTokenBody(raw, picks));
      // Append the saved row optimistically (it carries the server-stamped author
      // and timestamp) rather than re-fetching the whole thread.
      setComments((prev) => [...(prev ?? []), saved]);
      setText('');
      textRef.current = '';
      setPicks([]);
      setMq(null);
      setSuggestions([]);
      setComposing(false); // close the overlay; the thread updates behind it
    } catch {
      /* keep the draft so the user can retry */
    } finally {
      setPosting(false);
    }
  }

  async function remove(commentId: string) {
    // Optimistic: drop it immediately, restore the prior list on failure.
    const prev = comments;
    setComments((cur) => (cur ?? []).filter((cm) => String(cm.id) !== commentId));
    try {
      await host.client.deleteComment(commentId);
    } catch {
      setComments(prev ?? null);
    }
  }

  const count = comments?.length ?? 0;
  const canSend = !!text.trim() && !posting;

  return (
    <View style={{ marginTop: 8, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <LucideIcon name="message-square" size={16} color={c.muted} />
        <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>Comments</Text>
        {count > 0 ? <Text style={{ fontSize: 14, color: c.muted }}>{count}</Text> : null}
      </View>

      {/* Thread first, composer last — the order a mobile reader expects. */}
      {comments == null ? (
        <Text style={{ color: c.muted, fontSize: 13 }}>Loading…</Text>
      ) : comments.length === 0 ? (
        <Text style={{ color: c.muted, fontSize: 13 }}>No comments yet. Start the conversation below.</Text>
      ) : (
        <View style={{ gap: 14 }}>
          {comments.map((cm, i) => {
            const cid = String(cm.id ?? i);
            const author = (cm.authorName as string) || 'Unknown';
            const when = timeAgo(cm.createdAt as string);
            const edited = cm.editedAt ? ' · edited' : '';
            return (
              <View key={cid} style={{ flexDirection: 'row', gap: 10 }}>
                <Avatar url={cm.authorAvatarUrl as string} name={cm.authorName as string} c={c} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={1}>{author}</Text>
                    {when ? <Text style={{ fontSize: 12, color: c.muted }}>{when}{edited}</Text> : null}
                    {cm.canDelete ? (
                      <Touchable
                        onPress={() => remove(cid)}
                        hitSlop={8}
                        style={{ marginLeft: 'auto', padding: 2 }}
                        accessibilityLabel="Delete comment"
                      >
                        <LucideIcon name="trash-2" size={15} color={c.muted} />
                      </Touchable>
                    ) : null}
                  </View>
                  <Text style={{ fontSize: 14, color: c.text, marginTop: 2 }}>{renderBody(String(cm.body ?? ''), host, c)}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* The composer is keyboard-anchored (mobile pattern): this is just a trigger; tapping it
          opens an overlay where the input sits right above the keyboard and @-mentions pop up
          above it. Shows the current draft so a closed-but-unsent comment is still visible. */}
      <Touchable
        onPress={() => setComposing(true)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, borderWidth: 1, borderColor: c.fieldBorder, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, backgroundColor: c.fieldBg }}
      >
        <Text style={{ flex: 1, fontSize: 14, color: text.trim() ? c.text : c.muted }} numberOfLines={1}>
          {text.trim() ? text : 'Write a comment…'}
        </Text>
        <LucideIcon name="at-sign" size={16} color={c.muted} />
      </Touchable>

      {/* Compose overlay: input pinned just above the keyboard, suggestions stacked above it. */}
      <Modal visible={composing} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setComposing(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={() => setComposing(false)} />

          {mq && suggestions.length > 0 ? (
            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 240, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border }}>
              {suggestions.slice(0, 8).map((s, i) => (
                <Touchable
                  key={`${s.kind}/${s.id}/${i}`}
                  onPress={() => choose(s)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}
                >
                  <Avatar url={s.avatarUrl as string} name={s.display as string} c={c} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, color: c.text }} numberOfLines={1}>{String(s.display ?? '')}</Text>
                    {s.entity ? <Text style={{ fontSize: 11, color: c.muted }} numberOfLines={1}>{String(s.entity)}</Text> : null}
                  </View>
                  <LucideIcon name="at-sign" size={14} color={c.muted} />
                </Touchable>
              ))}
            </ScrollView>
          ) : null}

          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, backgroundColor: c.card, borderTopWidth: mq && suggestions.length > 0 ? 0 : 1, borderTopColor: c.border }}>
            <TextInput
              autoFocus
              style={{ flex: 1, borderWidth: 1, borderColor: c.fieldBorder, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.text, minHeight: 44, maxHeight: 120, backgroundColor: c.fieldBg }}
              value={text}
              onChangeText={onChangeText}
              onSelectionChange={onSelectionChange}
              placeholder="Write a comment…  (@ to mention)"
              placeholderTextColor={c.muted}
              multiline
              textAlignVertical="top"
              editable={!posting}
            />
            <Touchable
              style={{ height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 10, paddingHorizontal: 16, backgroundColor: c.accentBg, opacity: canSend ? 1 : 0.5 }}
              disabled={!canSend}
              onPress={send}
            >
              {posting ? (
                <ActivityIndicator color={c.accentFg} size="small" />
              ) : (
                <>
                  <LucideIcon name="send" size={15} color={c.accentFg} />
                  <Text style={{ color: c.accentFg, fontWeight: '600', fontSize: 14 }}>Send</Text>
                </>
              )}
            </Touchable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

export const onnoComments: CustomRenderer = ({ block, host }) => {
  const target = (block.custom_props?.target as Record<string, any>) ?? {};
  return <Comments target={target} host={host} />;
};
