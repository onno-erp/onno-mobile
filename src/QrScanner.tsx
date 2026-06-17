// In-app QR scanner for onboarding onto a server. Reads a code minted on a OneC
// server's web login page — `onec://connect?url=…` (or a plain `https://` server
// URL) — and hands the decoded string back to the caller, which parses and
// connects. Complements the OS-level deep link: opening the app and scanning
// works even when the system camera doesn't surface the custom-scheme link.

import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** The raw decoded QR string — the caller validates and connects. */
  onScanned: (data: string) => void;
}

export function QrScanner({ visible, onClose, onScanned }: Props) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  // onBarcodeScanned fires continuously while a code is in frame; latch on the
  // first hit so we report it once. Reset each time the scanner is (re)opened.
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (visible) setScanned(false);
  }, [visible]);

  // Prompt for access the first time the scanner opens, while we still can.
  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [visible, permission, requestPermission]);

  function handleBarcode({ data }: { data: string }) {
    if (scanned) return;
    setScanned(true);
    onScanned(data);
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {permission?.granted && (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={scanned ? undefined : handleBarcode}
          />
        )}

        <View style={styles.overlay} pointerEvents="box-none">
          {!permission ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : !permission.granted ? (
            <View style={styles.permission}>
              <Text style={styles.permTitle}>Camera access needed</Text>
              <Text style={styles.permBody}>Allow camera access to scan a server's QR code.</Text>
              <Pressable
                style={styles.permBtn}
                onPress={() => (permission.canAskAgain ? requestPermission() : Linking.openSettings())}
              >
                <Text style={styles.permBtnText}>
                  {permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View style={styles.reticle} />
              <Text style={styles.hint}>Point at the server's QR code</Text>
            </>
          )}
        </View>

        <Pressable onPress={onClose} hitSlop={12} style={[styles.close, { top: insets.top + 12 }]}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 20 },
  reticle: {
    width: 240,
    height: 240,
    borderRadius: 24,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.9)',
    backgroundColor: 'transparent',
  },
  hint: { color: '#FFFFFF', fontSize: 15, fontWeight: '500', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  permission: { alignItems: 'center', gap: 12, paddingHorizontal: 40 },
  permTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  permBody: { color: 'rgba(255,255,255,0.8)', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  permBtn: { marginTop: 8, backgroundColor: '#FFFFFF', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12 },
  permBtnText: { color: '#000000', fontSize: 15, fontWeight: '600' },
  close: {
    position: 'absolute',
    left: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
});
