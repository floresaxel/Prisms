import 'react-native-get-random-values';
import './src/crypto-setup'; // S9-F2: install crypto.subtle (WebCrypto) before any export call
import { registerRootComponent } from 'expo';

import { App } from './App';

registerRootComponent(App);
