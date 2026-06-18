// onno-form — create/edit a catalog or document. The server emits a portable
// descriptor (field metadata + initial values + submit target); we render
// controls, validate, and submit to the REST API. Port of the Flutter client's form custom.
// Covered: text (+ multiline / email / url / phone) / number / boolean (checkbox
// or switch) / enum / ref / date / datetime / time (a calendar + time-wheel sheet) /
// secret / media (image / gallery / file / map) + catalog code+description +
// document tabular sections.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Dimensions, Easing, Modal, Pressable, ScrollView as RNScrollView, StyleSheet, Switch, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Row } from '../../api/onnoClient';
import { colors, type ThemeColors } from '../theme';
import type { CustomRenderer, DivCardEnvelope, DivHost } from '../types';
import { DivCard } from '../DivCard';
import { GeoField, MapEditor } from './geo';
import { LucideIcon } from './lucide';
import { FileField, GalleryField, ImageField } from './media';
import { Touchable } from '../../ui/touchable';

type Attr = Record<string, any>;
const NUMERIC = new Set(['BigDecimal', 'Integer', 'Long', 'Double', 'Float', 'Short', 'int', 'long', 'double']);
const ThemeC = createContext<ThemeColors>(colors('light'));

function OnnoForm({ form, host }: { form: Record<string, any>; host: DivHost }) {
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
              // Carry the server-resolved ref label (`{col}_display`) so the picker shows the name,
              // not the stored uuid. Ignored by payload() (it only reads each attr's fieldName).
              const disp = r[`${col}_display`];
              if (disp != null) row[`${a.fieldName}_display`] = disp;
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

  // New rows go to the top so the tap has an immediately-visible result (the old append
  // dropped the row at the bottom, often off-screen — which read as "nothing happened").
  const addRow = (section: string) => setSections((p) => ({ ...p, [section]: [{}, ...(p[section] ?? [])] }));
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
      // Embedded create (opened from a reference picker): hand the saved row back so
      // the picker selects it and closes the overlay — don't navigate away.
      if (!isEdit && host.onCreated) {
        host.onCreated(saved);
        return;
      }
      if (savedId != null) host.fire(`onno://${kind}/${name}/${savedId}`);
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

  // Leave without saving. The form lives at its own route (…/{id}/edit or …/new),
  // so refresh() would just reload the form — i.e. look dead. Navigate away instead:
  // edit → back to the record's detail, create/duplicate → back to the list.
  function cancel() {
    if (isEdit && id != null) host.fire(`onno://${kind}/${name}/${id}`);
    else host.fire(`onno://${kind}/${name}`);
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
          <FieldControl key={a.fieldName} attr={a} value={values[a.fieldName]} display0={str(initial[`${a.columnName ?? a.fieldName}_display`])} error={errors[a.fieldName]} onChange={(v) => set(a.fieldName, v)} host={host} />
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

        <Touchable style={{ backgroundColor: c.accentBg, borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 20, opacity: saving ? 0.6 : 1 }} disabled={saving} onPress={submit}>
          {saving ? <ActivityIndicator color={c.accentFg} /> : <Text style={{ color: c.accentFg, fontWeight: '700', fontSize: 15 }}>{form.submitLabel ?? 'Save'}</Text>}
        </Touchable>
        <Touchable style={{ paddingVertical: 12, alignItems: 'center', marginTop: 8 }} disabled={saving} onPress={cancel}>
          <Text style={{ color: c.muted, fontWeight: '600' }}>Cancel</Text>
        </Touchable>
      </View>
    </ThemeC.Provider>
  );
}

// An editable grid for one tabular section: add/remove rows, each cell rendered by the same
// FieldControl the top-level fields use. On mobile each row is a stacked card (not a wide
// spreadsheet line) so ref pickers, enums and dates stay tappable. New rows land on top and
// briefly flash, so adding one is obviously felt.
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
  const press = c.primarySoft;
  const columns: Attr[] = ((section.attributes as Attr[]) ?? [])
    .filter((a) => a.visibleInForm !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const title = (section.label as string) ?? (section.name ? section.name.charAt(0).toUpperCase() + section.name.slice(1) : 'Rows');

  // Flash the just-added (top) row so the add reads as a clear, located change.
  const [flashing, setFlashing] = useState(false);
  const add = () => {
    onAdd();
    setFlashing(true);
    setTimeout(() => setFlashing(false), 1100);
  };

  const AddBtn = ({ label }: { label: string }) => (
    <Pressable
      onPress={add}
      android_ripple={{ color: press }}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? press : 'transparent' })}
    >
      <LucideIcon name="plus" size={15} color={c.primary} />
      <Text style={{ color: c.primary, fontWeight: '600', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ marginTop: 16, borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: 12, backgroundColor: c.card }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }} numberOfLines={1}>{title}</Text>
          {rows.length > 0 ? (
            <View style={{ minWidth: 22, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, backgroundColor: c.surface }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: c.muted }}>{rows.length}</Text>
            </View>
          ) : null}
        </View>
        <AddBtn label="Add row" />
      </View>
      {rows.length === 0 ? (
        <View style={{ alignItems: 'center', gap: 10, paddingVertical: 16 }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>No rows yet.</Text>
          <AddBtn label="Add the first row" />
        </View>
      ) : (
        rows.map((row, idx) => {
          const flash = idx === 0 && flashing;
          return (
            <View
              key={idx}
              style={{
                backgroundColor: flash ? c.successBg : c.surface,
                borderWidth: 1,
                borderColor: flash ? c.successFg : c.border,
                borderRadius: 12,
                padding: 12,
                marginTop: 8,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.muted, letterSpacing: 0.4 }}>{`ROW ${idx + 1}`}</Text>
                <Pressable
                  onPress={() => onRemove(idx)}
                  hitSlop={8}
                  style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: pressed ? c.dangerBg : 'transparent' })}
                >
                  <LucideIcon name="trash-2" size={15} color={c.dangerFg} />
                  <Text style={{ color: c.dangerFg, fontSize: 13, fontWeight: '600' }}>Remove</Text>
                </Pressable>
              </View>
              {columns.map((a) => (
                <FieldControl key={a.fieldName} attr={a} value={row[a.fieldName]} display0={str(row[`${a.fieldName}_display`])} onChange={(v) => onCell(idx, a.fieldName, v)} host={host} />
              ))}
            </View>
          );
        })
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

// A real checkbox that owns its label — the default for boolean fields (a Switch is opt-in
// via .widget("switch"/"toggle")). Tapping the whole row toggles it.
function Checkbox({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  const c = useContext(ThemeC);
  return (
    <Touchable onPress={() => onChange(!value)} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }}>
      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: value ? c.primary : c.fieldBorder, backgroundColor: value ? c.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        {value ? <LucideIcon name="check" size={15} color="#fff" /> : null}
      </View>
      <Text style={{ fontSize: 14, color: c.text, flex: 1 }}>{label}</Text>
    </Touchable>
  );
}

function FieldControl({ attr, value, error, onChange, host, display0 }: { attr: Attr; value: unknown; error?: string; onChange: (v: unknown) => void; host: DivHost; display0?: string }) {
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
  // A field widget hint (.field(...).widget("map"|"image"|…)) wins over the type-based control.
  // All store a plain String — coordinates for map, a stored-media reference URL for the rest.
  const widget = ((attr.widget as string) ?? '').toLowerCase();
  const str0 = value == null ? undefined : String(value);
  const onStr = (v: string) => onChange(v === '' ? null : v);
  if (/^geojson$/.test(widget)) {
    return (
      <Field label={label} required={required} error={error}>
        <MapEditor value={str0} onChange={onStr} theme={host.theme} lockScroll={host.lockScroll} />
      </Field>
    );
  }
  if (/^(map|geo|geolocation)$/.test(widget)) {
    return (
      <Field label={label} required={required} error={error}>
        <GeoField value={str0} onChange={onStr} theme={host.theme} lockScroll={host.lockScroll} />
      </Field>
    );
  }
  if (/^(images|gallery|photos)$/.test(widget)) {
    return (
      <Field label={label} required={required} error={error}>
        <GalleryField value={str0} onChange={onStr} host={host} />
      </Field>
    );
  }
  if (/^(image|photo|avatar)$/.test(widget)) {
    return (
      <Field label={label} required={required} error={error}>
        <ImageField value={str0} onChange={onStr} host={host} variant={widget === 'avatar' ? 'avatar' : 'image'} />
      </Field>
    );
  }
  if (/^(file|upload|attachment)$/.test(widget)) {
    return (
      <Field label={label} required={required} error={error}>
        <FileField value={str0} onChange={onStr} host={host} />
      </Field>
    );
  }
  if (attr.isRef === true) return <RefField attr={attr} value={value} error={error} onChange={onChange} host={host} label={label} required={required} initialDisplay={display0} />;
  if (attr.isEnum === true) {
    // Enum constants are stored — and must be submitted — as their deterministic UUID
    // (`enumValues[].id`): the same value the record holds and the server binds via
    // UUID.fromString. The label is the constant name ("DIRECT"). Submitting the name
    // was the "UUID 'DIRECT' doesn't exist" error; keying options by id also lets an
    // edited record (whose value IS that UUID) pre-select and show its name, not the uuid.
    const options: EnumOption[] = ((attr.enumValues as Attr[]) ?? [])
      .filter((e) => e?.id != null || e?.name != null)
      .map((e) => ({ value: String(e.id ?? e.name), label: String(e.displayName ?? e.label ?? e.name ?? e.id) }));
    return <EnumField label={label} required={required} error={error} value={str(value)} display0={display0} options={options} onChange={onChange} />;
  }
  if (javaType === 'boolean' || javaType === 'Boolean') {
    // A settings-style switch only when hinted; otherwise a plain checkbox (mirrors the web).
    if (/^(switch|toggle)$/.test(widget)) {
      return (
        <View style={{ marginVertical: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <Text style={{ fontSize: 14, color: c.text, fontWeight: '500', flex: 1 }}>{label}</Text>
            <Switch value={value === true} onValueChange={onChange} />
          </View>
          {error ? <Text style={{ color: c.dangerFg, fontSize: 12, marginTop: 4 }}>{error}</Text> : null}
        </View>
      );
    }
    return (
      <View style={{ marginVertical: 6 }}>
        <Checkbox value={value === true} onChange={onChange} label={label} />
        {error ? <Text style={{ color: c.dangerFg, fontSize: 12, marginTop: 2 }}>{error}</Text> : null}
      </View>
    );
  }
  // Date / datetime / time → a calendar (+ time wheel) sheet, keyed off the java type
  // or an explicit widget hint. Stores the ISO string the server round-trips.
  const dmode = temporalMode(javaType, widget);
  if (dmode) return <DateField label={label} required={required} error={error} value={value} mode={dmode} javaType={javaType} onChange={onChange} />;

  const number = NUMERIC.has(javaType);
  // Text variants: a multiline box, or a single-line field with the right keyboard.
  const multiline = /^(textarea|multiline|memo|note)$/.test(widget);
  const keyboardType: KeyboardTypeOptions =
    widget === 'email' ? 'email-address'
      : widget === 'url' ? 'url'
      : widget === 'phone' || widget === 'tel' ? 'phone-pad'
      : number ? 'numeric'
      : 'default';
  const noCorrect = widget === 'email' || widget === 'url';
  return (
    <Field label={label} required={required} error={error}>
      <Input
        value={str(value)}
        placeholder={attr.placeholder as string | undefined}
        keyboardType={keyboardType}
        autoCapitalize={noCorrect ? 'none' : undefined}
        autoCorrect={noCorrect ? false : undefined}
        multiline={multiline}
        style={multiline ? { minHeight: 96, paddingTop: 10, textAlignVertical: 'top' } : undefined}
        onChangeText={(t) => onChange(number ? (t === '' ? null : Number(t)) : t)}
      />
    </Field>
  );
}

// The configured representation of a ref row: prefer the description/name, fall back to
// code/number/id — mirrors the web's `displayOf`, so the picker shows the name when the
// catalog is set up to display by name (not its internal code).
function refDisplay(r: Row): string {
  // Framework rows carry underscore-prefixed system columns (_description, _name,
  // _code, _number, _id). Prefer the human name, fall back through code/number, and
  // only show the raw _id (a UUID) as a last resort. (The bug was checking `name`
  // instead of `_name`, so name-presented catalogs fell straight through to the UUID.)
  for (const v of [r._description, r._name, r._code, r._number]) {
    if (v != null && String(v).trim() !== '') return String(v);
  }
  return String(r._id ?? '');
}
// A muted secondary line (the code) shown under the name when it adds information.
function refSecondary(r: Row, primary: string): string | undefined {
  const code = r._code != null && String(r._code).trim() !== '' ? String(r._code) : '';
  return code && code !== primary ? code : undefined;
}

type EnumOption = { value: string; label: string };
type PickerRow = { id: string; label: string; sub?: string };

// The tappable field control that opens a Picker — shared by ref + enum so they look alike.
// Shows the resolved display, a chevron affordance, and a clear (×) for optional fields.
function SelectTrigger({ display, placeholder, onPress, onClear, icon = 'chevrons-up-down' }: { display?: string; placeholder: string; onPress: () => void; onClear?: () => void; icon?: string }) {
  const c = useContext(ThemeC);
  const press = c.primarySoft;
  const has = !!display;
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: press }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderWidth: 1,
        borderColor: c.fieldBorder,
        borderRadius: 10,
        paddingHorizontal: 12,
        minHeight: 46,
        backgroundColor: pressed ? press : c.fieldBg,
      })}
    >
      <Text style={{ flex: 1, fontSize: 15, color: has ? c.text : c.muted }} numberOfLines={1}>{has ? display : placeholder}</Text>
      {has && onClear ? (
        <Touchable onPress={onClear} hitSlop={10} style={{ padding: 2 }}>
          <LucideIcon name="x" size={16} color={c.muted} />
        </Touchable>
      ) : null}
      <LucideIcon name={icon} size={16} color={c.muted} />
    </Pressable>
  );
}

function RefField({ attr, value, error, onChange, host, label, required, initialDisplay }: { attr: Attr; value: unknown; error?: string; onChange: (v: unknown) => void; host: DivHost; label: string; required: boolean; initialDisplay?: string }) {
  const refKind = (attr.refKind ?? 'catalog') === 'document' ? 'documents' : 'catalogs';
  const target = (attr.refTarget as string) ?? '';
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false); // the inline "+ Create new" overlay
  const [rows, setRows] = useState<Row[]>([]);
  // Seed from the server-resolved label so an existing ref shows its name (not the stored uuid).
  const [display, setDisplay] = useState(initialDisplay || str(attr.__display));
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

  const shown = display || (value != null ? String(value) : undefined);
  return (
    <Field label={label} required={required} error={error}>
      <SelectTrigger
        display={shown}
        placeholder={`Select ${target || 'value'}…`}
        onPress={() => { setOpen(true); search(''); }}
        onClear={required ? undefined : () => { onChange(null); setDisplay(''); }}
      />
      <Picker
        open={open}
        loading={loading}
        title={`Select ${target}`}
        selectedId={value != null ? String(value) : undefined}
        onClose={() => setOpen(false)}
        onSearch={search}
        createLabel={`Create new ${target || 'item'}`}
        onCreate={() => setCreating(true)}
        rows={rows.map((r) => {
          const lbl = refDisplay(r);
          return { id: String(r._id), label: lbl, sub: refSecondary(r, lbl) };
        })}
        onPick={(opt) => { onChange(opt.id); setDisplay(opt.label); setOpen(false); }}
      />
      <CreateEntityModal
        visible={creating}
        refKind={refKind}
        target={target}
        host={host}
        onClose={() => setCreating(false)}
        onCreated={(row) => {
          // Select the freshly-created record and drop straight back into the document.
          onChange(String(row._id));
          setDisplay(refDisplay(row));
          setCreating(false);
          setOpen(false);
        }}
      />
    </Field>
  );
}

// Full-screen "create a related record" overlay, opened from a reference picker. It
// renders the target catalog/document's own server-driven create form (`/{kind}/{name}/new`)
// in a Modal *on top of* the document being filled — which stays mounted, so its
// in-progress values are preserved. The nested form reports its saved row via the
// host's `onCreated` (see OnnoForm.submit), so we never navigate away; Cancel (or any
// navigation the form fires) just closes the overlay.
function CreateEntityModal({ visible, refKind, target, host, onClose, onCreated }: {
  visible: boolean; refKind: string; target: string; host: DivHost; onClose: () => void; onCreated: (row: Row) => void;
}) {
  const c = colors(host.theme);
  const insets = useSafeAreaInsets();
  const [env, setEnv] = useState<DivCardEnvelope | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) {
      setEnv(null);
      setError('');
      return;
    }
    let alive = true;
    host.client
      .content(`/${refKind}/${target}/new`, { theme: host.theme })
      .then((e) => alive && setEnv(e as DivCardEnvelope))
      .catch((e: any) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [visible, refKind, target, host]);

  // Inside the create form the only navigations are "leave" intents (its own Cancel
  // fires onno://{kind}/{name}); collapse those to closing the overlay. A successful
  // save is captured by onCreated and never reaches here. Side-effect urls (open a
  // file / external link) still pass through to the real host.
  const nestedFire = useCallback(
    (url: string) => {
      const rest = url.startsWith('onno://') ? url.slice('onno://'.length) : '';
      if (/^(open\/|redirect\/|download\/|auth\/sso\/)/.test(rest)) host.fire(url);
      else onClose();
    },
    [host, onClose],
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: insets.top + 6, paddingBottom: 10, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
            <Touchable onPress={onClose} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 4, paddingRight: 8 }}>
              <LucideIcon name="chevron-left" size={22} color={c.primary} />
              <Text style={{ fontSize: 16, color: c.primary, fontWeight: '500' }}>Cancel</Text>
            </Touchable>
          </View>
          {env ? (
            <RNScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: 32 + insets.bottom }}
              keyboardShouldPersistTaps="handled"
              automaticallyAdjustKeyboardInsets
              keyboardDismissMode="interactive"
              showsVerticalScrollIndicator={false}
            >
              <DivCard
                envelope={env}
                client={host.client}
                baseUrl={host.baseUrl}
                theme={host.theme}
                fire={nestedFire}
                refresh={() => {}}
                onCreated={onCreated}
              />
            </RNScrollView>
          ) : error ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 }}>
              <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }}>Couldn’t open the form</Text>
              <Text style={{ color: c.muted, fontSize: 13, textAlign: 'center' }}>{error}</Text>
            </View>
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={c.primary} />
            </View>
          )}
        </GestureHandlerRootView>
      </View>
    </Modal>
  );
}

function EnumField({ label, required, error, value, options, onChange, display0 }: { label: string; required: boolean; error?: string; value: string; options: EnumOption[]; onChange: (v: unknown) => void; display0?: string }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <Field label={label} required={required} error={error}>
      <SelectTrigger
        display={selected?.label || display0 || (value || undefined)}
        placeholder="Select…"
        onPress={() => setOpen(true)}
        onClear={required ? undefined : () => onChange(null)}
      />
      <Picker
        open={open}
        title={label}
        selectedId={value || ''}
        onClose={() => setOpen(false)}
        rows={[{ id: '', label: '—' }, ...options.map((o) => ({ id: o.value, label: o.label }))]}
        onPick={(opt) => { onChange(opt.id || null); setOpen(false); }}
      />
    </Field>
  );
}

// ----- date / datetime / time -----

type DateMode = 'date' | 'datetime' | 'time';

// Map a field's java type (or an explicit widget hint) to a calendar mode, or null
// when it isn't temporal. Jackson serializes java.time as ISO-8601 strings, so values
// arrive/leave as text: LocalDate "2026-06-17", LocalDateTime "2026-06-17T14:30:00",
// LocalTime "14:30:00"; the zoned types carry a trailing offset/Z.
function temporalMode(javaType: string, widget: string): DateMode | null {
  switch (widget) {
    case 'date':
    case 'calendar':
      return 'date';
    case 'datetime':
    case 'datetime-local':
    case 'timestamp':
      return 'datetime';
    case 'time':
      return 'time';
  }
  switch (javaType) {
    case 'LocalDate':
      return 'date';
    case 'LocalTime':
    case 'OffsetTime':
      return 'time';
    case 'LocalDateTime':
    case 'Instant':
    case 'ZonedDateTime':
    case 'OffsetDateTime':
    case 'Date':
    case 'Timestamp':
      return 'datetime';
  }
  return null;
}

// Zoned / legacy instants round-trip in UTC (toISOString); the naive local types keep
// their wall-clock text, so the exact day/time the user picked is what gets stored.
function isZonedType(javaType: string): boolean {
  return javaType === 'Instant' || javaType === 'ZonedDateTime' || javaType === 'OffsetDateTime' || javaType === 'Date' || javaType === 'Timestamp';
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // Monday-first
const HOURS = Array.from({ length: 24 }, (_, i) => pad2(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => pad2(i));

function parseTemporal(value: unknown, mode: DateMode): Date | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(+d) ? null : d;
  }
  const s = String(value).trim();
  if (mode === 'time') {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (!m) return null;
    const d = new Date();
    d.setHours(+m[1], +m[2], m[3] ? +m[3] : 0, 0);
    return d;
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) return new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]); // local midnight — no UTC day-shift
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s); // carries a zone — let the engine convert to local
    return isNaN(+d) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  const d = new Date(s);
  return isNaN(+d) ? null : d;
}

function serializeTemporal(d: Date, mode: DateMode, zoned: boolean): string {
  if (mode === 'time') return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
  if (mode === 'date') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (zoned) return d.toISOString();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
}

function displayTemporal(d: Date, mode: DateMode): string {
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (mode === 'time') return time;
  if (mode === 'date') return date;
  return `${date}, ${time}`;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

// The 6×7 day grid for a month (Monday-first), padded with the adjacent months' days.
function monthGrid(viewMonth: Date): Date[] {
  const first = startOfMonth(viewMonth);
  const lead = (first.getDay() + 6) % 7; // days from Monday back to the 1st
  const start = new Date(first);
  start.setDate(1 - lead);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

function DateField({ label, required, error, value, mode, javaType, onChange }: {
  label: string; required: boolean; error?: string; value: unknown; mode: DateMode; javaType: string; onChange: (v: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = useMemo(() => parseTemporal(value, mode), [value, mode]);
  const zoned = isZonedType(javaType);
  return (
    <Field label={label} required={required} error={error}>
      <SelectTrigger
        display={current ? displayTemporal(current, mode) : undefined}
        placeholder={mode === 'time' ? 'Select time…' : mode === 'datetime' ? 'Select date & time…' : 'Select date…'}
        icon={mode === 'time' ? 'clock' : 'calendar'}
        onPress={() => setOpen(true)}
        onClear={!required && value != null ? () => onChange(null) : undefined}
      />
      <CalendarSheet
        open={open}
        mode={mode}
        value={current}
        onClose={() => setOpen(false)}
        onConfirm={(d) => {
          onChange(serializeTemporal(d, mode, zoned));
          setOpen(false);
        }}
      />
    </Field>
  );
}

const CAL_EXIT_MS = 200;

// A bottom-sheet calendar (+ time wheels for datetime/time). Slides up over a fading
// backdrop; edits a draft and commits on Done. Pure JS — no native picker module, so
// it works on the existing dev client and themes/feels like the rest of the app.
function CalendarSheet({ open, mode, value, onClose, onConfirm }: {
  open: boolean; mode: DateMode; value: Date | null; onClose: () => void; onConfirm: (d: Date) => void;
}) {
  const c = useContext(ThemeC);
  const insets = useSafeAreaInsets();
  const { height: screenH } = Dimensions.get('window');
  const [mounted, setMounted] = useState(open);
  const anim = useRef(new Animated.Value(0)).current;
  const [draft, setDraft] = useState<Date>(() => value ?? new Date());
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(value ?? new Date()));

  useEffect(() => {
    if (open) {
      setMounted(true);
      const seed = value ?? new Date();
      setDraft(seed);
      setViewMonth(startOfMonth(seed));
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, stiffness: 260, damping: 30, mass: 0.9 }).start();
    } else if (mounted) {
      Animated.timing(anim, { toValue: 0, duration: CAL_EXIT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!mounted) return null;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [screenH, 0] });
  const backdrop = anim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5], extrapolate: 'clamp' });
  const cells = monthGrid(viewMonth);
  const today = new Date();

  const pickDay = (d: Date) => {
    const nd = new Date(d);
    nd.setHours(draft.getHours(), draft.getMinutes(), 0, 0); // keep the chosen time
    setDraft(nd);
  };
  const setTime = (h: number, m: number) => {
    const nd = new Date(draft);
    nd.setHours(h, m, 0, 0);
    setDraft(nd);
  };
  const stepMonth = (delta: number) => setViewMonth((v) => new Date(v.getFullYear(), v.getMonth() + delta, 1));
  const jumpNow = () => {
    const now = new Date();
    setDraft(now);
    setViewMonth(startOfMonth(now));
  };

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <Animated.View style={{ flex: 1, backgroundColor: '#000', opacity: backdrop }} />
        </Pressable>
        <Animated.View style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 16 + insets.bottom, transform: [{ translateY }] }}>
          <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
            <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: c.border }} />
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 6, paddingBottom: 10, gap: 12 }}>
            <Text style={{ flex: 1, fontSize: 18, fontWeight: '800', letterSpacing: -0.3, color: c.text }} numberOfLines={1}>
              {mode === 'time' ? 'Select time' : displayTemporal(draft, mode)}
            </Text>
            <Touchable onPress={jumpNow} hitSlop={8} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: c.surface }}>
              <Text style={{ color: c.primary, fontWeight: '700', fontSize: 13 }}>{mode === 'time' ? 'Now' : 'Today'}</Text>
            </Touchable>
          </View>

          {mode !== 'time' && (
            <View style={{ paddingHorizontal: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, marginBottom: 4 }}>
                <Touchable onPress={() => stepMonth(-1)} hitSlop={8} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}>
                  <LucideIcon name="chevron-left" size={20} color={c.text} />
                </Touchable>
                <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{MONTHS_FULL[viewMonth.getMonth()]} {viewMonth.getFullYear()}</Text>
                <Touchable onPress={() => stepMonth(1)} hitSlop={8} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}>
                  <LucideIcon name="chevron-right" size={20} color={c.text} />
                </Touchable>
              </View>
              <View style={{ flexDirection: 'row' }}>
                {WEEKDAYS.map((w, i) => (
                  <Text key={i} style={{ flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600', color: c.muted, paddingVertical: 4 }}>{w}</Text>
                ))}
              </View>
              {Array.from({ length: 6 }).map((_, r) => (
                <View key={r} style={{ flexDirection: 'row' }}>
                  {cells.slice(r * 7, r * 7 + 7).map((d, i) => {
                    const inMonth = d.getMonth() === viewMonth.getMonth();
                    const sel = sameDay(d, draft);
                    const isToday = sameDay(d, today);
                    return (
                      <Touchable key={i} onPress={() => pickDay(d)} dim={1} style={{ flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', padding: 2 }}>
                        <View style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: sel ? c.primary : 'transparent', borderWidth: !sel && isToday ? 1.5 : 0, borderColor: c.primary }}>
                          <Text style={{ fontSize: 15, fontWeight: sel || isToday ? '700' : '500', color: sel ? '#fff' : inMonth ? c.text : c.muted }}>{d.getDate()}</Text>
                        </View>
                      </Touchable>
                    );
                  })}
                </View>
              ))}
            </View>
          )}

          {mode !== 'date' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginHorizontal: 18, paddingTop: mode === 'datetime' ? 8 : 16, marginTop: mode === 'datetime' ? 8 : 0, borderTopWidth: mode === 'datetime' ? StyleSheet.hairlineWidth : 0, borderTopColor: c.border }}>
              <Wheel values={HOURS} index={draft.getHours()} onIndex={(h) => setTime(h, draft.getMinutes())} />
              <Text style={{ fontSize: 22, fontWeight: '700', color: c.text }}>:</Text>
              <Wheel values={MINUTES} index={draft.getMinutes()} onIndex={(m) => setTime(draft.getHours(), m)} />
            </View>
          )}

          <Touchable onPress={() => onConfirm(draft)} style={{ backgroundColor: c.accentBg, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginHorizontal: 16, marginTop: 16 }}>
            <Text style={{ color: c.accentFg, fontWeight: '700', fontSize: 15 }}>Done</Text>
          </Touchable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const WHEEL_ITEM_H = 38;

// A vertical snapping number column (hour / minute) — the iOS time-wheel feel without
// a native module. The centred row (marked by a band) is the selection.
function Wheel({ values, index, onIndex }: { values: string[]; index: number; onIndex: (i: number) => void }) {
  const c = useContext(ThemeC);
  const ref = useRef<RNScrollView>(null);
  // Keep the scroll position aligned to the value — on mount, and when it changes
  // externally (Now/Today). A self-driven change lands on the same offset (a no-op).
  useEffect(() => {
    const t = setTimeout(() => ref.current?.scrollTo({ y: index * WHEEL_ITEM_H, animated: false }), 0);
    return () => clearTimeout(t);
  }, [index]);
  return (
    <View style={{ height: WHEEL_ITEM_H * 5, width: 66 }}>
      <RNScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={WHEEL_ITEM_H}
        decelerationRate="fast"
        contentContainerStyle={{ paddingVertical: WHEEL_ITEM_H * 2 }}
        onMomentumScrollEnd={(e) => {
          const i = Math.round(e.nativeEvent.contentOffset.y / WHEEL_ITEM_H);
          onIndex(Math.max(0, Math.min(values.length - 1, i)));
        }}
      >
        {values.map((v, i) => (
          <View key={i} style={{ height: WHEEL_ITEM_H, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 21, color: i === index ? c.text : c.muted, fontWeight: i === index ? '700' : '400' }}>{v}</Text>
          </View>
        ))}
      </RNScrollView>
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: WHEEL_ITEM_H * 2, height: WHEEL_ITEM_H, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border }} />
    </View>
  );
}

const SHEET_EXIT_MS = 220; // exit-slide window before the sheet unmounts

// A bottom-sheet picker built on the app's own overlay primitives, with the native
// polish @gorhom would have given us (it can't — it never measures its container on
// RN 0.85's bridgeless renderer, so the sheet had zero height). A transparent RN
// Modal (proven to render on bridgeless by ./dialog) hosts an Animated sheet with:
//   • two detents — `medium` (~half) and `large` (~full) — it snaps between, plus a
//     dismiss when flicked/dragged below medium. Search opens straight to large.
//   • drag-to-resize that does NOT close: drag up expands, down collapses, only the
//     bottom-most pull dismisses.
//   • scroll/drag coordination: at medium the whole sheet moves; at large the list
//     scrolls, and a pull-down from the top of the list collapses/dismisses it.
//   • a grabber, a backdrop that fades with position, server-search, and a checked row.
//
// Gestures use react-native-gesture-handler (`.runOnJS(true)`, like ../longPress)
// driving an RN Animated value, so it needs its own GestureHandlerRootView inside the
// Modal — the Modal mounts in a detached native tree with no root view of its own.
function Picker({ open, title, rows, onPick, onClose, onSearch, loading, selectedId, onCreate, createLabel }: {
  open: boolean; title: string; rows: PickerRow[]; onPick: (o: PickerRow) => void; onClose: () => void; onSearch?: (q: string) => void; loading?: boolean; selectedId?: string; onCreate?: () => void; createLabel?: string;
}) {
  const c = useContext(ThemeC);
  const insets = useSafeAreaInsets();
  const { height: screenH } = Dimensions.get('window');
  const [query, setQuery] = useState(''); // local search text, for the inline clear (×)

  // Geometry, in `translateY` space where 0 = fully up and larger values push the
  // sheet down; Y_CLOSED parks it off-screen.
  const maxH = screenH - insets.top - 8; // tallest the sheet may grow
  const midH = Math.round(screenH * 0.5); // the "medium" detent's visible height
  // Fixed lists (enums) size to their content so a 3-item picker isn't a half-empty
  // sheet. Search pickers keep the fixed medium/large detents — their result count
  // changes as you type, and we don't want the sheet resizing under the keyboard.
  const ROW_H = 48;
  const HEADER_H = 64;
  const estContentH = HEADER_H + rows.length * ROW_H + insets.bottom + 12;
  const fits = !onSearch && estContentH <= maxH;
  const sheetH = fits ? Math.max(200, estContentH) : maxH;
  const Y_LARGE = 0; // fully showing sheetH
  const Y_MED = fits ? 0 : Math.max(0, maxH - midH); // no medium detent when it fits
  const Y_CLOSED = sheetH + insets.bottom + 40;
  const openY = !fits && !onSearch ? Y_MED : Y_LARGE; // long enums open medium; search/fit open full

  // Kept in the tree through the exit slide; null at rest so closed pickers cost nothing.
  const [mounted, setMounted] = useState(open);
  // The list scrolls only when the content overflows (the large, !fits state); a
  // content-sized sheet has nothing to scroll, and at medium the drag resizes instead.
  const [scrollAtLarge, setScrollAtLarge] = useState(!fits && openY === Y_LARGE);
  const y = useRef(new Animated.Value(Y_CLOSED)).current; // sheet translateY (px)
  const posRef = useRef(Y_CLOSED); // latest settled/dragged y, read on gesture start
  const scrollRef = useRef<any>(null);
  const scrollYRef = useRef(0); // live list scroll offset
  const drag = useRef({ startY: 0, anchorTrans: 0, anchored: false, moved: false }).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const clampY = (v: number) => Math.max(Y_LARGE, Math.min(Y_CLOSED, v));

  // posRef is our own JS-tracked sheet position, NOT a read of the animated value:
  // with useNativeDriver the JS value doesn't follow a native spring, so reading it
  // back is unreliable on bridgeless (the bug where any handle-drag snapped closed).
  // Instead we set it ourselves — to the target when we start an animation, and to the
  // live value on every drag frame — and halt any running spring on gesture start so
  // the drag owns the value outright.
  useEffect(() => {
    if (open) {
      setMounted(true);
      setQuery('');
      setScrollAtLarge(openY === Y_LARGE);
      y.setValue(Y_CLOSED);
      posRef.current = openY; // where it's heading — so a grab during the open spring anchors sanely
      Animated.spring(y, { toValue: openY, useNativeDriver: true, stiffness: 240, damping: 28, mass: 0.9 }).start();
    } else if (mounted) {
      Animated.timing(y, { toValue: Y_CLOSED, duration: SHEET_EXIT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Release: project position with velocity, then dismiss (past/flicked below medium)
  // or spring to the nearer detent, toggling list scrolling to match.
  const snap = useCallback(
    (velocityY: number) => {
      const projected = posRef.current + velocityY * 0.15;
      // Dismiss only when the throw projects well below medium (or a hard downward
      // flick from it) — never on a small wiggle near a detent.
      const dismissLine = Y_MED + (Y_CLOSED - Y_MED) * 0.5;
      if (projected > dismissLine) {
        onCloseRef.current();
        return;
      }
      const target = Math.abs(projected - Y_LARGE) <= Math.abs(projected - Y_MED) ? Y_LARGE : Y_MED;
      posRef.current = target;
      setScrollAtLarge(target === Y_LARGE);
      Animated.spring(y, { toValue: target, useNativeDriver: true, stiffness: 300, damping: 32, mass: 0.9 }).start();
    },
    [Y_LARGE, Y_MED, Y_CLOSED, y],
  );

  // The grabber/header drags the sheet directly (no list underneath to coordinate with).
  const headerPan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetY([-8, 8])
        .onStart(() => {
          y.stopAnimation(); // own the value: no spring fighting the drag
          drag.startY = posRef.current;
        })
        .onUpdate((e) => {
          const next = clampY(drag.startY + e.translationY);
          y.setValue(next);
          posRef.current = next;
        })
        .onEnd((e) => snap(e.velocityY)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Y_LARGE, Y_MED, Y_CLOSED, snap],
  );

  // The list pan runs alongside the scroll. It only takes over (moving the sheet)
  // when the sheet isn't fully expanded, or when expanded-and-at-the-top and pulling
  // down — otherwise it stands aside and the list scrolls. It re-anchors at the moment
  // it takes over so the sheet doesn't jump.
  const listPan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetY([-8, 8])
        .simultaneousWithExternalGesture(scrollRef)
        .onStart(() => {
          y.stopAnimation(); // own the value: no spring fighting the drag
          drag.anchored = false;
          drag.moved = false;
        })
        .onUpdate((e) => {
          const atTop = scrollYRef.current <= 0;
          const expanded = posRef.current <= Y_LARGE + 1;
          const move = !expanded || (atTop && e.translationY > 0);
          if (move) {
            if (!drag.anchored) {
              drag.anchored = true;
              drag.anchorTrans = e.translationY;
              drag.startY = posRef.current;
              drag.moved = true;
            }
            const next = clampY(drag.startY + (e.translationY - drag.anchorTrans));
            y.setValue(next);
            posRef.current = next;
          } else {
            drag.anchored = false;
          }
        })
        .onEnd((e) => {
          if (drag.moved) snap(e.velocityY);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Y_LARGE, Y_MED, Y_CLOSED, snap],
  );

  if (!mounted) return null;

  const backdropOpacity = y.interpolate({ inputRange: [Y_LARGE, Y_MED, Y_CLOSED], outputRange: [0.5, 0.5, 0], extrapolate: 'clamp' });

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          {/* Backdrop behind the sheet: fades with position; tap above to close. */}
          <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={onClose}>
            <Animated.View style={{ flex: 1, backgroundColor: '#000', opacity: backdropOpacity }} />
          </Pressable>

          <Animated.View
            style={{
              height: sheetH,
              backgroundColor: c.card,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              overflow: 'hidden',
              transform: [{ translateY: y }],
            }}
          >
            <GestureDetector gesture={headerPan}>
              <View>
                <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 2 }}>
                  <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: c.border }} />
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 20, fontWeight: '800', letterSpacing: -0.4, color: c.text }} numberOfLines={1}>{title}</Text>
                    {onSearch ? (
                      <Text style={{ fontSize: 12.5, color: c.muted, marginTop: 2 }}>
                        {rows.length} {rows.length === 1 ? 'result' : 'results'}
                      </Text>
                    ) : null}
                  </View>
                  <Touchable
                    onPress={onClose}
                    hitSlop={10}
                    style={({ pressed }) => ({ width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.border : c.surface, alignItems: 'center', justifyContent: 'center' })}
                    dim={1}
                  >
                    <LucideIcon name="x" size={16} color={c.muted} />
                  </Touchable>
                </View>
                {onSearch && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, height: 44, backgroundColor: c.surface, marginHorizontal: 16, marginBottom: 8 }}>
                    <LucideIcon name="search" size={17} color={c.muted} />
                    <TextInput
                      value={query}
                      placeholder="Search…"
                      placeholderTextColor={c.muted}
                      autoCorrect={false}
                      autoCapitalize="none"
                      style={{ flex: 1, fontSize: 15.5, color: c.text, paddingVertical: 0 }}
                      onChangeText={(t) => {
                        setQuery(t);
                        onSearch(t);
                      }}
                    />
                    {query.length > 0 ? (
                      <Touchable
                        onPress={() => {
                          setQuery('');
                          onSearch('');
                        }}
                        hitSlop={8}
                        style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: c.border, alignItems: 'center', justifyContent: 'center' }}
                      >
                        <LucideIcon name="x" size={12} color={c.muted} />
                      </Touchable>
                    ) : null}
                  </View>
                )}
              </View>
            </GestureDetector>

            {loading ? (
              <View style={{ alignItems: 'center', paddingVertical: 48, gap: 12 }}>
                <ActivityIndicator color={c.primary} />
                <Text style={{ color: c.muted, fontSize: 13 }}>Searching…</Text>
              </View>
            ) : rows.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 44, gap: 12 }}>
                <View style={{ width: 56, height: 56, borderRadius: 28, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
                  <LucideIcon name="search-x" size={26} color={c.muted} />
                </View>
                <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }}>No matches</Text>
                <Text style={{ color: c.muted, fontSize: 13 }}>{onCreate ? 'Create it instead' : 'Try a different search'}</Text>
                {onCreate ? (
                  <Touchable
                    onPress={onCreate}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: c.primary, opacity: pressed ? 0.85 : 1, marginTop: 4 })}
                  >
                    <LucideIcon name="plus" size={17} color="#FFFFFF" />
                    <Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 14 }}>{createLabel ?? 'Create new'}</Text>
                  </Touchable>
                ) : null}
              </View>
            ) : (
              <GestureDetector gesture={listPan}>
                <ScrollView
                  ref={scrollRef}
                  style={{ flex: 1 }}
                  scrollEnabled={scrollAtLarge}
                  bounces={false}
                  overScrollMode="never"
                  onScroll={(e) => {
                    scrollYRef.current = e.nativeEvent.contentOffset.y;
                  }}
                  scrollEventThrottle={16}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 + insets.bottom }}
                >
                  {onCreate ? (
                    <Touchable
                      onPress={onCreate}
                      dim={1}
                      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 10, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: pressed ? c.primarySoft : 'transparent' })}
                    >
                      <LucideIcon name="plus" size={19} color={c.primary} />
                      <Text style={{ fontSize: 15.5, color: c.primary, fontWeight: '600' }}>{createLabel ?? 'Create new'}</Text>
                    </Touchable>
                  ) : null}
                  {rows.map((item, i) => {
                    const sel = selectedId != null && item.id === selectedId;
                    const none = item.id === '';
                    return (
                      <Touchable
                        key={item.id + i}
                        onPress={() => onPick(item)}
                        dim={1}
                        style={({ pressed }) => ({
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          marginHorizontal: 10,
                          paddingHorizontal: 14,
                          paddingVertical: 12,
                          borderRadius: 12,
                          backgroundColor: sel ? c.primarySoft : pressed ? c.surface : 'transparent',
                        })}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 15.5, color: sel ? c.primary : none ? c.muted : c.text, fontWeight: sel ? '600' : '500' }} numberOfLines={1}>
                            {none ? 'None' : item.label}
                          </Text>
                          {item.sub ? <Text style={{ fontSize: 12.5, color: c.muted, marginTop: 2 }} numberOfLines={1}>{item.sub}</Text> : null}
                        </View>
                        {sel ? <LucideIcon name="check" size={19} color={c.primary} /> : null}
                      </Touchable>
                    );
                  })}
                </ScrollView>
              </GestureDetector>
            )}
          </Animated.View>
        </View>
      </GestureHandlerRootView>
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

export const onnoForm: CustomRenderer = ({ block, host }) => {
  const form = (block.custom_props?.form as Record<string, any>) ?? {};
  return <OnnoForm form={form} host={host} />;
};
