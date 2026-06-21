/**
 * Root screen — book list with per-book last-synced time and Sync button.
 *
 * Navigation is dead simple state:
 *   view='list'  → shows BookCard for each book
 *   view='sync'  → full-screen SyncWebView for the selected book
 *
 * No React Navigation needed; there are only two "screens."
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { BOOKS } from './src/books/registry';
import type { BookConfig } from './src/books/types';
import type { Bet } from './src/bets/types';
import { SyncWebView } from './src/webview/SyncWebView';
import { upsertBets, configureNeon, type BetRow } from './src/neon/client';
import { initNotifications, scheduleSyncReminder } from './src/notify/reminders';
import { loadSettings, saveSettings, type Settings, DEFAULT_SETTINGS } from './src/settings/store';
import { SettingsScreen } from './src/settings/SettingsScreen';

// ─── per-book persistent state (stored in-memory; add SecureStore for persistence) ─

interface BookState {
  lastSyncedAt: string | null; // ISO timestamp
  lastBetCount: number | null;
  error: string | null;
}

function makeInitialState(): Record<string, BookState> {
  return Object.fromEntries(
    BOOKS.map((b) => [b.key, { lastSyncedAt: null, lastBetCount: null, error: null }]),
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// ─── main component ──────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<'list' | 'sync' | 'settings'>('list');
  const [activeBook, setActiveBook] = useState<BookConfig | null>(null);
  const [bookStates, setBookStates] = useState<Record<string, BookState>>(makeInitialState());
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    void initNotifications();
    loadSettings().then((s) => {
      setSettings(s);
      configureNeon({ dataUrl: s.neonDataUrl, authUrl: s.neonAuthUrl, email: s.neonEmail, password: s.neonPassword });
    });
  }, []);

  const handleSaveSettings = (s: Settings) => {
    setSettings(s);
    configureNeon({ dataUrl: s.neonDataUrl, authUrl: s.neonAuthUrl, email: s.neonEmail, password: s.neonPassword });
    setView('list');
  };

  const openSync = (book: BookConfig) => {
    setActiveBook(book);
    setSyncing(true);
    setView('sync');
  };

  const closeSync = useCallback(() => {
    setView('list');
    setActiveBook(null);
    setSyncing(false);
  }, []);

  const handleBets = useCallback(
    async (bets: Bet[]) => {
      if (!activeBook) return;
      const siteKey = activeBook.key;
      try {
        const betsToSave = settings.saveHistoricBets
          ? bets
          : bets.filter((b) => b.status === 'open');
        const rows: BetRow[] = betsToSave.map((b) => ({
          site_key:        siteKey,
          external_bet_id: b.externalBetId,
          placed_at:       b.placedAt ?? null,
          status:          b.status ?? null,
          stake:           b.stake ?? null,
          potential_payout: b.potentialPayout ?? null,
          selections:      b.selections ?? null,
          raw:             b.raw ?? null,
        }));
        await upsertBets(rows);
        const now = new Date().toISOString();
        const openCount = bets.filter((b) => b.status === 'open').length;
        setBookStates((prev) => ({
          ...prev,
          [siteKey]: { lastSyncedAt: now, lastBetCount: openCount, error: null },
        }));
        await scheduleSyncReminder();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setBookStates((prev) => ({
          ...prev,
          [siteKey]: { ...prev[siteKey]!, error: msg },
        }));
      }
    },
    [activeBook],
  );

  const handleError = useCallback(
    (msg: string) => {
      if (!activeBook) return;
      setBookStates((prev) => ({
        ...prev,
        [activeBook.key]: { ...prev[activeBook.key]!, error: msg },
      }));
    },
    [activeBook],
  );

  // ── settings view ──
  if (view === 'settings') {
    return (
      <>
        <StatusBar style="dark" />
        <SettingsScreen
          settings={settings}
          books={BOOKS}
          onSave={handleSaveSettings}
          onBack={() => setView('list')}
        />
      </>
    );
  }

  // ── sync view ──
  if (view === 'sync' && activeBook) {
    const bookCreds = settings.books[activeBook.key] ?? { email: '', password: '' };
    return (
      <>
        <StatusBar style="dark" />
        <SyncWebView
          book={activeBook}
          bookEmail={bookCreds.email}
          bookPassword={bookCreds.password}
          onBets={(bets) => { void handleBets(bets); }}
          onDone={closeSync}
          onError={handleError}
        />
      </>
    );
  }

  // ── book list ──
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.appTitle}>Bet Loader</Text>
        <TouchableOpacity onPress={() => setView('settings')} style={styles.settingsBtn}>
          <Text style={styles.settingsBtnText}>Settings</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {BOOKS.map((book) => {
          const state = bookStates[book.key]!;
          return (
            <View key={book.key} style={styles.card}>
              <View style={styles.cardContent}>
                <Text style={styles.bookName}>{book.label}</Text>
                {state.lastSyncedAt ? (
                  <Text style={styles.meta}>
                    Synced {timeAgo(state.lastSyncedAt)}
                    {state.lastBetCount != null ? ` · ${state.lastBetCount} open` : ''}
                  </Text>
                ) : (
                  <Text style={styles.metaNever}>Never synced</Text>
                )}
                {state.error ? (
                  <Text style={styles.error} numberOfLines={2}>
                    {state.error}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                style={[styles.syncBtn, syncing && styles.syncBtnDisabled]}
                onPress={() => openSync(book)}
                disabled={syncing}
              >
                <Text style={styles.syncBtnText}>Sync</Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  appTitle: { flex: 1, fontSize: 24, fontWeight: '700', color: '#111' },
  settingsBtn: { paddingVertical: 4, paddingLeft: 12 },
  settingsBtnText: { fontSize: 15, color: '#1a73e8' },
  list: { padding: 16, gap: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardContent: { flex: 1 },
  bookName: { fontSize: 18, fontWeight: '600', color: '#111', marginBottom: 4 },
  meta: { fontSize: 13, color: '#666' },
  metaNever: { fontSize: 13, color: '#aaa' },
  error: { fontSize: 12, color: '#dc2626', marginTop: 4 },
  syncBtn: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  syncBtnDisabled: { backgroundColor: '#aaa' },
  syncBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
