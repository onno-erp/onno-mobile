// Media field controls for the form's `.widget(...)` hints: "image"/"photo" + "avatar"
// (single image), "images"/"gallery" (several, newline-joined), and "file"/"upload"/
// "attachment" (any file). The chosen file is streamed to POST /api/media and only the
// returned reference URL is stored on the String attribute — the same attach-by-URL shape
// the web SPA uses (image-picker.tsx / file-picker.tsx). Native file selection uses Expo's
// Go-bundled pickers (expo-image-picker / expo-document-picker); no dev build needed.

import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { DivHost } from '../types';
import { colors } from '../theme';
import { Touchable } from '../../ui/touchable';
import { LucideIcon } from './lucide';

// Client-side guard mirroring the server's onno.media.max-file-size default (10 MB); the server
// validates authoritatively, this just gives instant feedback.
const MAX_BYTES = 10 * 1024 * 1024;
// Several images live newline-joined in one String attribute (stored/data URLs carry no newline).
const GALLERY_SEP = '\n';

function absUrl(url: string, baseUrl?: string): string {
  if (!url || !baseUrl) return url;
  if (/^https?:\/\//.test(url) || url.startsWith('data:')) return url;
  return baseUrl.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);
}

function leafOf(url: string): string {
  const path = url.split(/[?#]/)[0];
  const leaf = path.substring(path.lastIndexOf('/') + 1);
  return leaf || url;
}

// ----- native pickers -> upload params -----

async function pickImages(multiple: boolean): Promise<ImagePicker.ImagePickerAsset[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert('Permission needed', 'Allow photo-library access to add images.');
    return [];
  }
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsMultipleSelection: multiple });
  return res.canceled ? [] : res.assets;
}

async function pickDocument(): Promise<DocumentPicker.DocumentPickerAsset | null> {
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  return res.canceled || !res.assets.length ? null : res.assets[0];
}

// Upload one picked asset, returning its stored URL (or null on rejection). `size`/`name`/`type`
// differ slightly between the image and document assets, so callers normalize before this.
async function upload(host: DivHost, file: { uri: string; name: string; type: string; size?: number }): Promise<string | null> {
  if (file.size != null && file.size > MAX_BYTES) {
    Alert.alert('Too large', `"${file.name}" exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit.`);
    return null;
  }
  try {
    const stored = await host.client.uploadMedia({ uri: file.uri, name: file.name, type: file.type });
    return stored.url;
  } catch (e: any) {
    Alert.alert('Upload failed', `Couldn't upload "${file.name}": ${String(e?.message ?? e)}`);
    return null;
  }
}

const imageUpload = (a: ImagePicker.ImagePickerAsset) => ({
  uri: a.uri,
  name: a.fileName ?? leafOf(a.uri) ?? 'image.jpg',
  type: a.mimeType ?? 'image/jpeg',
  size: a.fileSize,
});
const docUpload = (a: DocumentPicker.DocumentPickerAsset) => ({
  uri: a.uri,
  name: a.name ?? leafOf(a.uri) ?? 'file',
  type: a.mimeType ?? 'application/octet-stream',
  size: a.size,
});

// ----- single image / avatar -----

export function ImageField({ value, onChange, host, variant = 'image' }: { value?: string; onChange: (v: string) => void; host: DivHost; variant?: 'image' | 'avatar' }) {
  const c = colors(host.theme);
  const [busy, setBusy] = useState(false);
  const avatar = variant === 'avatar';
  const hasImage = typeof value === 'string' && value.length > 0;

  const choose = async () => {
    if (busy) return;
    const assets = await pickImages(false);
    if (!assets.length) return;
    setBusy(true);
    try {
      const url = await upload(host, imageUpload(assets[0]));
      if (url) onChange(url);
    } finally {
      setBusy(false);
    }
  };

  const box = avatar
    ? { width: 112, height: 112, borderRadius: 56 }
    : { width: '100%' as const, height: 176, borderRadius: 12 };

  return (
    <View style={{ gap: 8, alignItems: avatar ? 'flex-start' : 'stretch' }}>
      <Touchable
        onPress={choose}
        disabled={busy}
        style={{ ...box, borderWidth: 1, borderColor: c.border, borderStyle: hasImage ? 'solid' : 'dashed', backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
      >
        {hasImage ? (
          <Image source={{ uri: absUrl(value!, host.baseUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        ) : (
          <View style={{ alignItems: 'center', gap: 6, padding: 12 }}>
            {busy ? <ActivityIndicator color={c.muted} /> : <LucideIcon name="image-plus" size={22} color={c.muted} />}
            <Text style={{ fontSize: 12, color: c.muted, textAlign: 'center' }}>{busy ? 'Uploading…' : avatar ? 'Add photo' : 'Choose an image'}</Text>
          </View>
        )}
        {hasImage && busy ? (
          <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' }}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : null}
      </Touchable>
      {hasImage ? (
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <TextButton icon="upload" label="Replace" color={c.muted} disabled={busy} onPress={choose} />
          <TextButton icon="trash-2" label="Remove" color={c.dangerFg} disabled={busy} onPress={() => onChange('')} />
        </View>
      ) : null}
    </View>
  );
}

// ----- multi-image gallery -----

export function GalleryField({ value, onChange, host }: { value?: string; onChange: (v: string) => void; host: DivHost }) {
  const c = colors(host.theme);
  const [uploading, setUploading] = useState(0);
  const urls = (value ?? '')
    .split(GALLERY_SEP)
    .map((s) => s.trim())
    .filter(Boolean);

  const add = async () => {
    const assets = await pickImages(true);
    if (!assets.length) return;
    setUploading((n) => n + assets.length);
    try {
      const results = await Promise.all(assets.map((a) => upload(host, imageUpload(a))));
      const accepted = results.filter((u): u is string => !!u);
      if (accepted.length) onChange([...urls, ...accepted].join(GALLERY_SEP));
    } finally {
      setUploading((n) => Math.max(0, n - assets.length));
    }
  };

  const removeAt = (idx: number) => onChange(urls.filter((_, i) => i !== idx).join(GALLERY_SEP));

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {urls.map((url, idx) => (
          <View key={idx} style={{ width: 96, height: 96, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: c.border }}>
            <Image source={{ uri: absUrl(url, host.baseUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
            <Touchable
              onPress={() => removeAt(idx)}
              hitSlop={6}
              style={{ position: 'absolute', right: 4, top: 4, width: 24, height: 24, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}
            >
              <LucideIcon name="x" size={14} color="#fff" />
            </Touchable>
          </View>
        ))}
        {Array.from({ length: uploading }).map((_, i) => (
          <View key={`u-${i}`} style={{ width: 96, height: 96, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={c.muted} />
          </View>
        ))}
        <Touchable
          onPress={add}
          style={{ width: 96, height: 96, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', gap: 4 }}
        >
          <LucideIcon name="image-plus" size={20} color={c.muted} />
          <Text style={{ fontSize: 11, color: c.muted }}>Add</Text>
        </Touchable>
      </View>
      <Text style={{ fontSize: 11, color: c.muted }}>{urls.length ? `${urls.length} image${urls.length > 1 ? 's' : ''}` : 'No images yet'}</Text>
    </View>
  );
}

// ----- any file -----

export function FileField({ value, onChange, host }: { value?: string; onChange: (v: string) => void; host: DivHost }) {
  const c = colors(host.theme);
  const [busy, setBusy] = useState(false);
  const hasFile = typeof value === 'string' && value.length > 0;

  const choose = async () => {
    if (busy) return;
    const asset = await pickDocument();
    if (!asset) return;
    setBusy(true);
    try {
      const url = await upload(host, docUpload(asset));
      if (url) onChange(url);
    } finally {
      setBusy(false);
    }
  };

  if (hasFile) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.surface, paddingHorizontal: 12, paddingVertical: 10 }}>
        <LucideIcon name="paperclip" size={16} color={c.muted} />
        <Touchable style={{ flex: 1 }} onPress={() => Linking.openURL(absUrl(value!, host.baseUrl)).catch(() => {})}>
          <Text style={{ fontSize: 14, color: c.text }} numberOfLines={1}>
            {leafOf(value!)}
          </Text>
        </Touchable>
        {busy ? (
          <ActivityIndicator color={c.muted} />
        ) : (
          <>
            <Touchable onPress={choose} hitSlop={6} style={{ padding: 4 }}>
              <LucideIcon name="upload" size={16} color={c.muted} />
            </Touchable>
            <Touchable onPress={() => onChange('')} hitSlop={6} style={{ padding: 4 }}>
              <LucideIcon name="trash-2" size={16} color={c.dangerFg} />
            </Touchable>
          </>
        )}
      </View>
    );
  }

  return (
    <Touchable
      onPress={choose}
      disabled={busy}
      style={{ height: 80, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, borderRadius: 12, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', gap: 6 }}
    >
      {busy ? <ActivityIndicator color={c.muted} /> : <LucideIcon name="file-up" size={20} color={c.muted} />}
      <Text style={{ fontSize: 12, color: c.muted }}>{busy ? 'Uploading…' : 'Choose a file'}</Text>
    </Touchable>
  );
}

function TextButton({ icon, label, color, disabled, onPress }: { icon: string; label: string; color: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Touchable onPress={onPress} disabled={disabled} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, opacity: disabled ? 0.5 : 1 }}>
      <LucideIcon name={icon} size={14} color={color} />
      <Text style={{ fontSize: 12, color }}>{label}</Text>
    </Touchable>
  );
}
