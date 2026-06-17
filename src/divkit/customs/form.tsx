// onec-form — create/edit a catalog or document. The server emits a portable
// descriptor (field metadata + initial values + submit target); we render
// controls, validate, and submit to the REST API. Port of onec_form.dart.
// Covered: text / number / boolean / enum / ref / date / secret + catalog
// code+description. Not yet: tabular sections (shown as a notice).

import React, { createContext, useContext, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Switch, Text, TextInput, View } from 'react-native';
import type { Row } from '../../api/onecClient';
import { colors, type ThemeColors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';

type Attr = Record<string, any>;
const NUMERIC = new Set(['BigDecimal', 'Integer', 'Long', 'Double', 'Float', 'Short', 'int', 'long', 'double']);
const ThemeC = createContext<ThemeColors>(colors('light'));

function OnecForm({ form, host }: { form: Record<string, any>; host: DivHost }) {
  const c = colors(host.theme);
  const meta = form.meta ?? {};
  const initial: Row = form.initial ?? {};
  const kind = (form.kind as string) ?? 'catalogs';
  const name = (form.name as string) ?? '';
  const id = form.id as string | undefined;
  const isEdit = id != null && form.duplicate !== true;

  const attributes: Attr[] = useMemo(
    () => ((meta.attributes as Attr[]) ?? []).filter((a) => a.visibleInForm !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [meta],
  );

  // Document child collections. The metadata ships them with the form.
  const tabularSections: Attr[] = useMemo(() => (Array.isArray(meta.tabularSections) ? meta.tabularSections : []), [meta]);

  const [values, setValues] = useState<Row>(() => {
    const v: Row = {};
    if (kind === 'catalogs') {
      if (meta.autoNumber !== true) v.__code = initial._code;
      v.__description = initial._description;
    }
    for (const a of attributes) {
      if (a.secret === true) continue;
      v[a.fieldName] = initial[a.columnName ?? a.fieldName];
    }
    return v;
  });
  // Rows per section, keyed by attribute fieldName. Loaded rows arrive keyed by column name, so
  // seed each cell from initial[section][columnName] — the same column→field asymmetry the
  // top-level fields handle. All attributes are seeded (not just visible) so hidden columns
  // survive the delete-and-reinsert on save.
  const [sections, setSections] = useState<Record<string, Row[]>>(() => {
    const seed: Record<string, Row[]> = {};
    for (const ts of tabularSections) {
      const raw = initial[ts.name];
      const attrs: Attr[] = (ts.attributes as Attr[]) ?? [];
      seed[ts.name] = Array.isArray(raw)
        ? (raw as Row[]).map((r) => {
            const row: Row = {};
            for (const a of attrs) {
              if (a.secret === true) continue;
              const col = a.columnName ?? a.fieldName;
              if (r[col] != null) row[a.fieldName] = r[col];
            }
            return row;
          })
        : [];
    }
    return seed;
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const set = (field: string, value: unknown) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => {
      if (!e[field]) return e;
      const { [field]: _, ...rest } = e;
      return rest;
    });
  };

  const addRow = (section: string) => setSections((p) => ({ ...p, [section]: [...(p[section] ?? []), {}] }));
  const removeRow = (section: string, idx: number) =>
    setSections((p) => ({ ...p, [section]: (p[section] ?? []).filter((_, i) => i !== idx) }));
  const setCell = (section: string, idx: number, key: string, value: unknown) =>
    setSections((p) => ({ ...p, [section]: (p[section] ?? []).map((row, i) => (i === idx ? { ...row, [key]: value } : row)) }));

  function validate(): boolean {
    const errs: Record<string, string> = {};
    for (const a of attributes) {
      if (a.required === true && a.secret !== true) {
        const v = values[a.fieldName];
        if (v == null || (typeof v === 'string' && !v.trim())) errs[a.fieldName] = `'${a.displayName}' is required`;
      }
    }
    if (kind === 'catalogs' && meta.autoNumber !== true && !String(values.__code ?? '').trim()) errs.__code = 'Code is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function payload(): Row {
    const body: Row = {};
    if (kind === 'catalogs') {
      if (values.__code != null) body.code = values.__code;
      if (values.__description != null) body.description = values.__description;
    }
    for (const a of attributes) {
      const field = a.fieldName as string;
      if (a.secret === true) {
        if (values[field]) body[field] = values[field];
        continue;
      }
      body[field] = values[field];
    }
    // Attach each tabular section as rows keyed by fieldName. Drop rows where every attribute is
    // blank; booleans map to primitive columns, so always send true/false (never null).
    for (const ts of tabularSections) {
      const attrs: Attr[] = (ts.attributes as Attr[]) ?? [];
      body[ts.name] = (sections[ts.name] ?? [])
        .filter((row) => attrs.some((a) => row[a.fieldName] != null && row[a.fieldName] !== ''))
        .map((row) => {
          const out: Row = {};
          for (const a of attrs) {
            const v = row[a.fieldName];
            out[a.fieldName] = a.javaType === 'boolean' || a.javaType === 'Boolean' ? v === true : v ?? null;
          }
          return out;
        });
    }
    if (isEdit && initial._version != null) body._version = initial._version;
    return body;
  }

  async function submit() {
    if (!validate()) return;
    setSaving(true);
    setNotice('');
    try {
      const saved = isEdit ? await host.client.updateEntity(kind, name, id!, payload()) : await host.client.createEntity(kind, name, payload());
      const savedId = saved._id ?? id;
      if (savedId != null) host.fire(`onec://${kind}/${name}/${savedId}`);
      else host.refresh();
    } catch (e: any) {
      const data = e?.data;
      if (data?.fieldErrors) {
        const fe: Record<string, string> = {};
        for (const [k, v] of Object.entries(data.fieldErrors)) fe[k] = Array.isArray(v) ? String(v[0]) : String(v);
        setErrors(fe);
        setNotice('Please fix the errors');
      } else {
        setNotice(String(data?.message ?? e?.message ?? 'Save failed'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <ThemeC.Provider value={c}>
      <View>
        <Text style={{ fontSize: 20, fontWeight: '700', color: c.text, marginBottom: 12 }}>{form.title ?? 'Form'}</Text>

        {kind === 'catalogs' && meta.autoNumber !== true && (
          <Field label="Code" required error={errors.__code}>
            <Input value={str(values.__code)} onChangeText={(t) => set('__code', t)} />
          </Field>
        )}
        {kind === 'catalogs' && (
          <Field label="Description">
            <Input value={str(values.__description)} onChangeText={(t) => set('__description', t)} />
          </Field>
        )}

        {attributes.map((a) => (
          <FieldControl key={a.fieldName} attr={a} value={values[a.fieldName]} error={errors[a.fieldName]} onChange={(v) => set(a.fieldName, v)} host={host} />
        ))}

        {tabularSections.map((ts) => (
          <SectionEditor
            key={ts.name}
            section={ts}
            rows={sections[ts.name] ?? []}
            host={host}
            onAdd={() => addRow(ts.name)}
            onRemove={(i) => removeRow(ts.name, i)}
            onCell={(i, key, v) => setCell(ts.name, i, key, v)}
          />
        ))}

        {notice ? <Text style={{ color: c.dangerFg, fontSize: 12, marginTop: 8 }}>{notice}</Text> : null}

        <Pressable style={{ backgroundColor: c.accentBg, borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 20, opacity: saving ? 0.6 : 1 }} disabled={saving} onPress={submit}>
          {saving ? <ActivityIndicator color={c.accentFg} /> : <Text style={{ color: c.accentFg, fontWeight: '700', fontSize: 15 }}>{form.submitLabel ?? 'Save'}</Text>}
        </Pressable>
        <Pressable style={{ paddingVertical: 12, alignItems: 'center', marginTop: 8 }} disabled={saving} onPress={() => host.refresh()}>
          <Text style={{ color: c.muted, fontWeight: '600' }}>Cancel</Text>
        </Pressable>
      </View>
    </ThemeC.Provider>
  );
}

// An editable grid for one tabular section: add/remove rows, each cell rendered by the same
// FieldControl the top-level fields use. On mobile each row is a stacked card (not a wide
// spreadsheet line) so ref pickers, enums and dates stay tappable.
function SectionEditor({
  section,
  rows,
  host,
  onAdd,
  onRemove,
  onCell,
}: {
  section: Attr;
  rows: Row[];
  host: DivHost;
  onAdd: () => void;
  onRemove: (idx: number) => void;
  onCell: (idx: number, key: string, value: unknown) => void;
}) {
  const c = useContext(ThemeC);
  const columns: Attr[] = ((section.attributes as Attr[]) ?? [])
    .filter((a) => a.visibleInForm !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const title = (section.label as string) ?? (section.name ? section.name.charAt(0).toUpperCase() + section.name.slice(1) : 'Rows');

  return (
    <View style={{ marginTop: 16, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 12, backgroundColor: c.card }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{title}</Text>
        <Pressable onPress={onAdd} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border }}>
          <Text style={{ color: c.primary, fontWeight: '600', fontSize: 13 }}>+ Add row</Text>
        </Pressable>
      </View>
      {rows.length === 0 ? (
        <Text style={{ color: c.muted, fontSize: 13 }}>No rows yet.</Text>
      ) : (
        rows.map((row, idx) => (
          <View key={idx} style={{ backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 10, marginTop: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: c.muted }}>{`Row ${idx + 1}`}</Text>
              <Pressable onPress={() => onRemove(idx)} hitSlop={6}>
                <Text style={{ color: c.dangerFg, fontSize: 13, fontWeight: '600' }}>Remove</Text>
              </Pressable>
            </View>
            {columns.map((a) => (
              <FieldControl key={a.fieldName} attr={a} value={row[a.fieldName]} onChange={(v) => onCell(idx, a.fieldName, v)} host={host} />
            ))}
          </View>
        ))
      )}
    </View>
  );
}

function Input(props: React.ComponentProps<typeof TextInput>) {
  const c = useContext(ThemeC);
  return (
    <TextInput
      placeholderTextColor={c.muted}
      {...props}
      style={[{ borderWidth: 1, borderColor: c.fieldBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: c.text, backgroundColor: c.fieldBg, minHeight: 44 }, props.style]}
    />
  );
}

function FieldControl({ attr, value, error, onChange, host }: { attr: Attr; value: unknown; error?: string; onChange: (v: unknown) => void; host: DivHost }) {
  const c = useContext(ThemeC);
  const label = (attr.displayName as string) ?? attr.fieldName;
  const required = attr.required === true;
  const javaType = (attr.javaType as string) ?? 'String';

  if (attr.secret === true) {
    return (
      <Field label={label} error={error}>
        <Input secureTextEntry placeholder="Leave blank to keep current" onChangeText={onChange} />
      </Field>
    );
  }
  if (attr.isRef === true) return <RefField attr={attr} value={value} error={error} onChange={onChange} host={host} label={label} required={required} />;
  if (attr.isEnum === true) {
    const options: string[] = ((attr.enumValues as Attr[]) ?? []).map((e) => e.name).filter(Boolean);
    return <EnumField label={label} required={required} error={error} value={str(value)} options={options} onChange={onChange} />;
  }
  if (javaType === 'boolean' || javaType === 'Boolean') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: 8 }}>
        <Text style={{ fontSize: 13, color: c.text, fontWeight: '500' }}>{label}</Text>
        <Switch value={value === true} onValueChange={onChange} />
      </View>
    );
  }
  const number = NUMERIC.has(javaType);
  return (
    <Field label={label} required={required} error={error}>
      <Input value={str(value)} placeholder={attr.placeholder as string | undefined} keyboardType={number ? 'numeric' : 'default'} onChangeText={(t) => onChange(number ? (t === '' ? null : Number(t)) : t)} />
    </Field>
  );
}

function RefField({ attr, value, error, onChange, host, label, required }: { attr: Attr; value: unknown; error?: string; onChange: (v: unknown) => void; host: DivHost; label: string; required: boolean }) {
  const c = useContext(ThemeC);
  const refKind = (attr.refKind ?? 'catalog') === 'document' ? 'documents' : 'catalogs';
  const target = (attr.refTarget as string) ?? '';
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [display, setDisplay] = useState(str(attr.__display));
  const [loading, setLoading] = useState(false);

  async function search(q: string) {
    setLoading(true);
    try {
      setRows(await host.client.typeahead(refKind, target, q, 30));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Field label={label} required={required} error={error}>
      <Pressable
        style={{ borderWidth: 1, borderColor: c.fieldBorder, borderRadius: 8, paddingHorizontal: 12, minHeight: 44, justifyContent: 'center', backgroundColor: c.fieldBg }}
        onPress={() => { setOpen(true); search(''); }}
      >
        <Text style={{ color: display || value ? c.text : c.muted }}>{display || (value ? String(value) : 'Select…')}</Text>
      </Pressable>
      <Picker
        open={open}
        loading={loading}
        title={`Select ${target}`}
        onClose={() => setOpen(false)}
        onSearch={search}
        rows={rows.map((r) => ({ id: String(r._id), label: String(r._code ?? r._description ?? r.name ?? r._id) }))}
        onPick={(opt) => { onChange(opt.id); setDisplay(opt.label); setOpen(false); }}
      />
    </Field>
  );
}

function EnumField({ label, required, error, value, options, onChange }: { label: string; required: boolean; error?: string; value: string; options: string[]; onChange: (v: unknown) => void }) {
  const c = useContext(ThemeC);
  const [open, setOpen] = useState(false);
  return (
    <Field label={label} required={required} error={error}>
      <Pressable style={{ borderWidth: 1, borderColor: c.fieldBorder, borderRadius: 8, paddingHorizontal: 12, minHeight: 44, justifyContent: 'center', backgroundColor: c.fieldBg }} onPress={() => setOpen(true)}>
        <Text style={{ color: value ? c.text : c.muted }}>{value || '—'}</Text>
      </Pressable>
      <Picker open={open} title={label} onClose={() => setOpen(false)} rows={[{ id: '', label: '—' }, ...options.map((o) => ({ id: o, label: o }))]} onPick={(opt) => { onChange(opt.id || null); setOpen(false); }} />
    </Field>
  );
}

function Picker({ open, title, rows, onPick, onClose, onSearch, loading }: {
  open: boolean; title: string; rows: { id: string; label: string }[]; onPick: (o: { id: string; label: string }) => void; onClose: () => void; onSearch?: (q: string) => void; loading?: boolean;
}) {
  const c = useContext(ThemeC);
  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: c.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 24 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: c.border }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>{title}</Text>
            <Pressable onPress={onClose}><Text style={{ color: c.primary, fontWeight: '600' }}>Close</Text></Pressable>
          </View>
          {onSearch && <Input placeholder="Search…" style={{ margin: 12 }} onChangeText={onSearch} autoFocus />}
          {loading ? (
            <ActivityIndicator style={{ marginVertical: 24 }} color={c.text} />
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(it, i) => it.id + i}
              renderItem={({ item }) => (
                <Pressable style={{ paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border }} onPress={() => onPick(item)}>
                  <Text style={{ fontSize: 15, color: c.text }}>{item.label}</Text>
                </Pressable>
              )}
              style={{ maxHeight: 360 }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function Field({ label, required, error, children }: { label: string; required?: boolean; error?: string; children: React.ReactNode }) {
  const c = useContext(ThemeC);
  return (
    <View style={{ marginVertical: 6 }}>
      <Text style={{ fontSize: 13, color: c.text, marginBottom: 4, fontWeight: '500' }}>{label}{required ? ' *' : ''}</Text>
      {children}
      {error ? <Text style={{ color: c.dangerFg, fontSize: 12, marginTop: 4 }}>{error}</Text> : null}
    </View>
  );
}

const str = (v: unknown) => (v == null ? '' : String(v));

export const onecForm: CustomRenderer = ({ block, host }) => {
  const form = (block.custom_props?.form as Record<string, any>) ?? {};
  return <OnecForm form={form} host={host} />;
};
