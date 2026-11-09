import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { LocaleProvider } from './i18n/LocaleProvider.tsx';
import { Capacitor } from '@capacitor/core';
import { installNativeApiTransport } from './utils/apiClient.ts';

installNativeApiTransport();

createRoot(document.getElementById('root')!).render(<LocaleProvider><App /></LocaleProvider>);

if (!Capacitor.isNativePlatform() && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.error('Service worker registration failed:', error);
    });
  });
}
