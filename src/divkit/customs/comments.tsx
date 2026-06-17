// onec-comments — a per-record discussion thread. custom_props.target =
// { kind, name, id }; the widget loads/posts from /api/comments/... Port of
// onec_comments.dart.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import type { Row } from '../../api/onecClient';
import { formatMonthDay, pickField } from '../format';
import { colors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';

function Comments({ target, host }: { target: Record<string, any>; host: DivHost }) {
  const c = colors(host.theme);
  const kind = (target.kind as string) ?? '';
  const name = (target.name as string) ?? '';
  const id = (target.id as string) ?? '';
  const [comments, setComments] = useState<Row[] | null>(null);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

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

  async function send() {
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      await host.client.addComment(kind, name, id, body);
      setText('');
      await load();
    } catch {
      /* keep text */
    } finally {
      setPosting(false);
    }
  }

  return (
    <View>
      <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 10 }}>Comments</Text>
      <View style={{ gap: 8, marginBottom: 14 }}>
        <TextInput
          style={{ borderWidth: 1, borderColor: c.fieldBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.text, minHeight: 44, backgroundColor: c.fieldBg }}
          value={text}
          onChangeText={setText}
          placeholder="Add a comment…"
          placeholderTextColor={c.muted}
          multiline
        />
        <Pressable
          style={{ backgroundColor: c.accentBg, borderRadius: 8, paddingVertical: 10, alignItems: 'center', alignSelf: 'flex-start', paddingHorizontal: 20, opacity: !text.trim() || posting ? 0.5 : 1 }}
          disabled={!text.trim() || posting}
          onPress={send}
        >
          {posting ? <ActivityIndicator color={c.accentFg} size="small" /> : <Text style={{ color: c.accentFg, fontWeight: '600' }}>Post</Text>}
        </Pressable>
      </View>

      {comments == null ? (
        <ActivityIndicator style={{ marginVertical: 16 }} color={c.text} />
      ) : comments.length === 0 ? (
        <Text style={{ color: c.muted, fontSize: 12 }}>No comments yet.</Text>
      ) : (
        comments.map((cm, i) => {
          const author = pickField(cm, ['author_display', 'author', 'createdBy', 'user']) ?? '—';
          const dateStr = String(cm._date ?? cm.createdAt ?? cm.created_at ?? '');
          const body = String(cm.body ?? cm.text ?? '');
          return (
            <View key={cm._id ?? i} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ fontWeight: '600', color: c.text, fontSize: 13 }}>{author}</Text>
                {dateStr ? <Text style={{ color: c.muted, fontSize: 12 }}>{formatMonthDay(dateStr) ?? ''}</Text> : null}
              </View>
              <Text style={{ color: c.text, fontSize: 14 }}>{body}</Text>
            </View>
          );
        })
      )}
    </View>
  );
}

export const onecComments: CustomRenderer = ({ block, host }) => {
  const target = (block.custom_props?.target as Record<string, any>) ?? {};
  return <Comments target={target} host={host} />;
};
