// Where the OneC backend lives. The iOS simulator shares the host network, so
// `localhost` reaches the Mac. (On an Android emulator this would need
// `http://10.0.2.2:<port>`; on a physical device, the Mac's LAN IP.)
//
// Override at runtime with `EXPO_PUBLIC_ONEC_BASE_URL` (Expo inlines
// `EXPO_PUBLIC_*` env vars into the bundle).
// NB: point at the API ROOT, not the web SPA. e.g. the Rentals example serves
// its web UI at :8899/ui but its API at :8899/api — so the base is :8899.
export const ONEC_BASE_URL =
  process.env.EXPO_PUBLIC_ONEC_BASE_URL ?? 'http://localhost:8899';
