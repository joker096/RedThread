import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { LocaleProvider } from './i18n/LocaleProvider.tsx';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { installNativeApiTransport } from './utils/apiClient.ts';
import { parseVowDeepLink, publishVowDeepLink } from './utils/mobileDeepLinks.ts';

installNativeApiTransport();

if (Capacitor.isNativePlatform()) {
  const appLinkHost = import.meta.env.VITE_APP_LINK_HOST;
  const forwardNativeUrl = (rawUrl: unknown) => {
    const link = parseVowDeepLink(rawUrl, appLinkHost);
    if (!link) return;
    // Android removes the Custom Tab when the verified link opens the
    // singleTask activity. Browser.close() here can relaunch it on Android.
    // iOS keeps SFSafariViewController presented, so close it explicitly.
    if (link.type === 'identity-return' && Capacitor.getPlatform() === 'ios') {
      void Browser.close().catch(() => { /* Browser may already be dismissed. */ });
    }
    publishVowDeepLink(rawUrl, appLinkHost);
  };

  // Register the listener before reading the launch URL so foreground and
  // cold-start links are both handled. Tokens are never written to logs.
  void CapacitorApp.addListener('appUrlOpen', event => forwardNativeUrl(event.url)).catch(() => {
    // Deep-link delivery is unavailable until the native plugin is synced.
  });
  void CapacitorApp.getLaunchUrl()
    .then(result => { if (result?.url) forwardNativeUrl(result.url); })
    .catch(() => { /* A normal app launch has no URL to process. */ });

  void CapacitorApp.addListener('appStateChange', state => {
    if (state.isActive) window.dispatchEvent(new Event('vow:app-resumed'));
  }).catch(() => {
    // Resume refresh is an enhancement; API focus refresh remains available.
  });
}

createRoot(document.getElementById('root')!).render(<LocaleProvider><App /></LocaleProvider>);

if (!Capacitor.isNativePlatform() && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.error('Service worker registration failed:', error);
    });
  });
}
