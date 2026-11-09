import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Provisional identifier: confirm the final reverse-DNS id before first store release.
  appId: 'com.vow.app',
  appName: 'Vow',
  webDir: 'dist',
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor'
  }
};

export default config;
