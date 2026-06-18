// Gesture handler must be imported once, before anything else, so its native
// module initializes correctly (required by the swipe-back + long-press gestures).
import 'react-native-gesture-handler';

import { registerRootComponent } from 'expo';
import { createElement } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import App from './App';

// Root provider stack:
//   GestureHandlerRootView — required at the top for gesture-handler (swipe-back, long-press).
//   SafeAreaProvider       — so useSafeAreaInsets() can read notch / home-indicator insets.
// (The form picker's bottom sheet is a self-contained Modal overlay — see
// src/divkit/customs/form.tsx — so no BottomSheetModalProvider is needed.)
const Root = () =>
  createElement(
    GestureHandlerRootView,
    { style: { flex: 1 } },
    createElement(SafeAreaProvider, null, createElement(App)),
  );

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
registerRootComponent(Root);
