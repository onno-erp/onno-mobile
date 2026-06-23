// The default Onno backend the app seeds the server picker with. Points at the public demo cloud so a
// fresh install (e.g. on a physical device, where `localhost` would be the phone itself) has something
// real to connect to out of the box.
//
// Override at runtime with `EXPO_PUBLIC_ONNO_BASE_URL` (Expo inlines `EXPO_PUBLIC_*` env vars into the
// bundle) — e.g. `http://localhost:8080` against a local server on the simulator (which shares the
// Mac's network). NB: point at the API ROOT, not the web SPA (the API lives under `/api`).
export const ONNO_BASE_URL =
  process.env.EXPO_PUBLIC_ONNO_BASE_URL ?? 'https://demo.cloud.onno.su';
