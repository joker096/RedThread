import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { LocaleProvider } from './i18n/LocaleProvider.tsx';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { installNativeApiTransport } from './utils/apiClient.ts';
import { publishVowDeepLink } from './utils/mobileDeepLinks.ts';

installNativeApiTransport();

if (Capacitor.isNativePlatform()) {
  const forwardNativeUrl = (rawUrl: unknown) => publishVowDeepLink(rawUrl);

  // Register the listener before reading the launch URL so foreground and
  // cold-start links are both handled. Tokens are never written to logs.
  void CapacitorApp.addListener('appUrlOpen', event => forwardNativeUrl(event.url));
  void CapacitorApp.getLaunchUrl()
    .then(result => { if (result?.url) forwardNativeUrl(result.url); })
    .catch(() => { /* A normal app launch has no URL to process. */ });
}

createRoot(document.getElementById('root')!).render(<LocaleProvider><App /></LocaleProvider>);

if (!Capacitor.isNativePlatform() && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.error('Service worker registration failed:', error);
    });
  });
}
