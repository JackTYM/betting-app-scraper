/**
 * SyncWebView — full-screen WebView that loads the book's SPA, injects the
 * bet-harvesting script, and relays postMessage events to React Native.
 *
 * Messages from the WebView:
 *   {type:'status', state:'awaiting-auth'|'fetching'}
 *   {type:'bets', book:'...', bets:[...]}
 *   {type:'error', message:'...'}
 *   {type:'mfa', mfaId:'...'}   — pauses the injected JS; we must call
 *                                  injectJavaScript('window.__mfaResolve("CODE")') to resume.
 *   {type:'debug', message:'...'}
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import * as SecureStore from 'expo-secure-store';
import type { BookConfig } from '../books/types';
import type { Bet } from '../bets/types';

interface Props {
  book: BookConfig;
  bookEmail: string;
  bookPassword: string;
  onBets: (bets: Bet[]) => void;
  onDone: () => void;
  onError?: (msg: string) => void;
}

type SyncState = 'loading' | 'awaiting-auth' | 'fetching' | 'mfa' | 'done' | 'error';

export function SyncWebView({ book, bookEmail, bookPassword, onBets, onDone, onError }: Props) {
  const [syncState, setSyncState] = useState<SyncState>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [betCount, setBetCount] = useState<number | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  // null = still loading from SecureStore; {} = loaded, nothing stored
  const [storedLS, setStoredLS] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    SecureStore.getItemAsync(`betloader:ls:${book.key}`)
      .then((raw) => setStoredLS(raw ? (JSON.parse(raw) as Record<string, string>) : {}))
      .catch(() => setStoredLS({}));
  }, [book.key]);

  const injectedJS = useMemo(() => {
    if (storedLS === null) return '';
    const mainJS = book.buildInjectedJS(bookEmail, bookPassword);
    if (Object.keys(storedLS).length === 0) return mainJS;
    // Restore saved localStorage before page scripts run so the site sees the
    // same device fingerprint (fdGeneratedDeviceIdCookie, PerimeterX tokens).
    const jsonArg = JSON.stringify(JSON.stringify(storedLS));
    const prefix = `(function(){try{var d=JSON.parse(${jsonArg});Object.keys(d).forEach(function(k){try{localStorage.setItem(k,d[k]);}catch(e){}});}catch(e){}})();\n`;
    return prefix + mainJS;
  }, [storedLS, book, bookEmail, bookPassword]);

  const webViewRef = useRef<WebView>(null);

  const submitMfa = useCallback(
    (code: string) => {
      if (!code.trim()) return;
      setMfaCode('');
      setSyncState('fetching');
      webViewRef.current?.injectJavaScript(
        `if (typeof window.__mfaResolve === 'function') { window.__mfaResolve(${JSON.stringify(code.trim())}); } true;`
      );
    },
    [],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.nativeEvent.data) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.type === 'debug') {
        console.log(`[${book.key}] ${String(msg.message ?? '')}`);
      } else if (msg.type === 'localStorage') {
        const data = msg.data as Record<string, string>;
        SecureStore.setItemAsync(`betloader:ls:${book.key}`, JSON.stringify(data)).catch(() => {});
      } else if (msg.type === 'status') {
        const state = msg.state as string;
        setSyncState(state === 'awaiting-auth' ? 'awaiting-auth' : 'fetching');
      } else if (msg.type === 'mfa') {
        setSyncState('mfa');
      } else if (msg.type === 'bets') {
        const rawBets = (msg.bets as Record<string, unknown>[]) ?? [];
        const bets: Bet[] = rawBets.map((r) => book.mapBet(r));
        setBetCount(bets.filter((b) => b.status === 'open').length);
        setSyncState('done');
        onBets(bets);
        setTimeout(onDone, 1500);
      } else if (msg.type === 'error') {
        const message = String(msg.message ?? 'Unknown error');
        setErrorMsg(message);
        setSyncState('error');
        onError?.(message);
      }
    },
    [book, onBets, onDone, onError],
  );

  const statusLabel: Record<SyncState, string> = {
    loading:         'Loading...',
    'awaiting-auth': `Log in to ${book.label} to sync your bets`,
    fetching:        'Fetching bets...',
    mfa:             'Verification required',
    done:            `Done — ${betCount ?? 0} active bets`,
    error:           `Error: ${errorMsg ?? 'unknown'}`,
  };

  const statusColor: Record<SyncState, string> = {
    loading:         '#888',
    'awaiting-auth': '#1a73e8',
    fetching:        '#f59e0b',
    mfa:             '#7c3aed',
    done:            '#16a34a',
    error:           '#dc2626',
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onDone} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{book.label}</Text>
      </View>

      {/* Status bar */}
      <View style={[styles.statusBar, { backgroundColor: statusColor[syncState] + '22' }]}>
        {syncState === 'fetching' && (
          <ActivityIndicator size="small" color={statusColor[syncState]} style={styles.spinner} />
        )}
        <Text style={[styles.statusText, { color: statusColor[syncState] }]}>
          {statusLabel[syncState]}
        </Text>
      </View>

      {/* WebView — deferred until SecureStore read completes so the localStorage
           restoration prefix is baked into injectedJavaScriptBeforeContentLoaded */}
      {storedLS === null ? (
        <ActivityIndicator style={styles.webview} />
      ) : (
      <WebView
        ref={webViewRef}
        style={styles.webview}
        source={{ uri: book.homeUrl }}
        injectedJavaScriptBeforeContentLoaded={injectedJS}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={book.injectedJavaScriptForMainFrameOnly ?? true}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        incognito={false}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        userAgent={book.userAgent}
        onLoadEnd={() => setSyncState((s) => (s === 'loading' ? 'awaiting-auth' : s))}
        onNavigationStateChange={(navState) => {
          if (book.key === 'fanduel') {
            console.log(`[fanduel nav] ${navState.url} (loading=${navState.loading})`);
          }
        }}
      />
      )}

      {/*
       * 2FA sheet — slides up when the injected JS pauses waiting for an MFA code.
       * textContentType="oneTimeCode" triggers iOS's automatic OTP suggestion banner
       * above the keyboard (reads the code directly from SMS / iMessage / email).
       * The sheet also auto-submits as soon as the user enters 6 digits.
       */}
      <Modal visible={syncState === 'mfa'} transparent animationType="slide">
        <KeyboardAvoidingView
          style={styles.mfaOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.mfaSheet}>
            <Text style={styles.mfaTitle}>Two-factor authentication</Text>
            <Text style={styles.mfaBody}>
              Enter the verification code sent to your phone or email by {book.label}.
            </Text>
            <TextInput
              style={styles.mfaInput}
              value={mfaCode}
              onChangeText={(t) => {
                setMfaCode(t);
                if (t.trim().length === 6) submitMfa(t);
              }}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoFocus
              placeholder="000000"
              placeholderTextColor="#aaa"
              maxLength={8}
            />
            <TouchableOpacity
              style={[styles.mfaBtn, !mfaCode.trim() && styles.mfaBtnDisabled]}
              onPress={() => submitMfa(mfaCode)}
              disabled={!mfaCode.trim()}
            >
              <Text style={styles.mfaBtnText}>Submit</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 56,
    paddingBottom: 8,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
    backgroundColor: '#fff',
  },
  backBtn: { paddingRight: 16, paddingVertical: 4 },
  backText: { fontSize: 16, color: '#1a73e8' },
  title: { fontSize: 18, fontWeight: '600', color: '#111' },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 38,
  },
  spinner: { marginRight: 8 },
  statusText: { fontSize: 14, flexShrink: 1 },
  webview: { flex: 1 },

  mfaOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  mfaSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  mfaTitle: { fontSize: 18, fontWeight: '700', color: '#111', marginBottom: 8 },
  mfaBody: { fontSize: 14, color: '#555', marginBottom: 20, lineHeight: 20 },
  mfaInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    padding: 14,
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
    marginBottom: 16,
    color: '#111',
  },
  mfaBtn: {
    backgroundColor: '#7c3aed',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  mfaBtnDisabled: { backgroundColor: '#c4b5fd' },
  mfaBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
