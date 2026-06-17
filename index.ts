import { registerRootComponent } from 'expo';
import { createElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import App from './App';

// SafeAreaProvider must wrap the root so useSafeAreaInsets() can read the
// device's notch / home-indicator insets anywhere in the tree below.
const Root = () => createElement(SafeAreaProvider, null, createElement(App));

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Root);
