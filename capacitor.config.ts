import type { CapacitorConfig } from '@capacitor/cli';

const allowInsecureMobileDev = process.env.VOW_ALLOW_INSECURE_MOBILE_DEV === 'true';

const config: CapacitorConfig = {
  // Provisional identifier: confirm the final reverse-DNS id before first store release.
  appId: 'com.vow.app',
  appName: 'Vow',
  webDir: 'dist',
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
    cleartext: allowInsecureMobileDev
  },
  android: {
    allowMixedContent: allowInsecureMobileDev
  }
};

export default config;
