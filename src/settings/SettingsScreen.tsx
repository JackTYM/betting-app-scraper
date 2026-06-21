import React, { useState } from 'react';
import {
  Keyboard,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { BookConfig } from '../books/types';
import { type Settings, saveSettings } from './store';

interface Props {
  settings: Settings;
  books: BookConfig[];
  onSave: (s: Settings) => void;
  onBack: () => void;
}

export function SettingsScreen({ settings, books, onSave, onBack }: Props) {
  const [draft, setDraft] = useState<Settings>(() => ({
    ...settings,
    books: { ...settings.books },
  }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');

  function setNeon<K extends keyof Omit<Settings, 'books'>>(key: K, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setTestState('idle');
  }

  function setBookField(bookKey: string, field: 'email' | 'password', value: string) {
    setDraft((d) => ({
      ...d,
      books: {
        ...d.books,
        [bookKey]: { ...d.books[bookKey], [field]: value },
      },
    }));
  }

  async function handleTest() {
    Keyboard.dismiss();
    const { neonAuthUrl: authUrl, neonEmail: email, neonPassword: password } = draft;
    if (!authUrl || !email || !password) {
      setTestState('error');
      setTestMsg('Auth URL, email, and password are required');
      return;
    }
    setTestState('testing');
    setTestMsg('');
    try {
      // Sign in — auto-register if the account doesn't exist yet.
      let signInResp = await fetch(`${authUrl}/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      if (!signInResp.ok) {
        const signUpResp = await fetch(`${authUrl}/sign-up/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost' },
          credentials: 'include',
          body: JSON.stringify({ email, password, name: email, callbackURL: 'http://localhost' }),
        });
        if (!signUpResp.ok) {
          const body = await signInResp.text();
          setTestState('error');
          setTestMsg(`Sign-in failed (${signInResp.status}): ${body.slice(0, 150)}`);
          return;
        }
        signInResp = await fetch(`${authUrl}/sign-in/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        if (!signInResp.ok) {
          const body = await signInResp.text();
          setTestState('error');
          setTestMsg(`Sign-in failed after registration (${signInResp.status}): ${body.slice(0, 150)}`);
          return;
        }
      }

      const sessionResp = await fetch(`${authUrl}/get-session`, { credentials: 'include' });
      if (!sessionResp.ok) {
        setTestState('error');
        setTestMsg(`get-session failed: ${sessionResp.status}`);
        return;
      }
      const jwt = sessionResp.headers.get('set-auth-jwt');
      if (!jwt) {
        setTestState('error');
        setTestMsg('No JWT returned — check Auth URL');
        return;
      }
      setTestState('ok');
      setTestMsg('Connected');
    } catch (e) {
      setTestState('error');
      setTestMsg(e instanceof Error ? e.message : 'Connection failed');
    }
  }

  async function handleSave() {
    Keyboard.dismiss();
    setSaving(true);
    setSaveError(null);
    try {
      await saveSettings(draft);
    } catch (e) {
      setSaving(false);
      setSaveError(e instanceof Error ? e.message : 'Save failed');
      return;
    }
    onSave(draft);
  }

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Settings</Text>
        <TouchableOpacity
          onPress={() => { void handleSave(); }}
          disabled={saving}
          style={styles.saveBtn}
        >
          <Text style={[styles.saveBtnText, saving && styles.saveBtnDisabled]}>
            {saving ? 'Saving…' : 'Save'}
          </Text>
        </TouchableOpacity>
      </View>

      {saveError ? <Text style={styles.saveError}>{saveError}</Text> : null}

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Neon */}
        <Text style={styles.sectionLabel}>Neon</Text>
        <View style={styles.card}>
          <Field label="Data URL" value={draft.neonDataUrl} onChangeText={(v) => setNeon('neonDataUrl', v)} keyboardType="url" />
          <Divider />
          <Field label="Auth URL" value={draft.neonAuthUrl} onChangeText={(v) => setNeon('neonAuthUrl', v)} keyboardType="url" />
          <Divider />
          <Field label="Email" value={draft.neonEmail} onChangeText={(v) => setNeon('neonEmail', v)} autoCapitalize="none" keyboardType="email-address" />
          <Divider />
          <Field label="Password" value={draft.neonPassword} onChangeText={(v) => setNeon('neonPassword', v)} secureTextEntry />
        </View>

        <TouchableOpacity
          onPress={() => { void handleTest(); }}
          disabled={testState === 'testing'}
          style={styles.testBtn}
        >
          <Text style={styles.testBtnText}>
            {testState === 'testing' ? 'Testing…' : 'Test Neon Connection'}
          </Text>
        </TouchableOpacity>
        {testState === 'ok' && <Text style={styles.testOk}>{testMsg}</Text>}
        {testState === 'error' && <Text style={styles.testError}>{testMsg}</Text>}

        {/* Sync options */}
        <Text style={styles.sectionLabel}>Sync</Text>
        <View style={styles.card}>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Save historic bets</Text>
            <Switch
              value={draft.saveHistoricBets}
              onValueChange={(v) => setDraft((d) => ({ ...d, saveHistoricBets: v }))}
            />
          </View>
        </View>

        {/* Per-book */}
        {books.map((book) => {
          const creds = draft.books[book.key] ?? { email: '', password: '' };
          return (
            <React.Fragment key={book.key}>
              <Text style={styles.sectionLabel}>{book.label}</Text>
              <View style={styles.card}>
                <Field
                  label="Email"
                  value={creds.email}
                  onChangeText={(v) => setBookField(book.key, 'email', v)}
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                <Divider />
                <Field
                  label="Password"
                  value={creds.password}
                  onChangeText={(v) => setBookField(book.key, 'password', v)}
                  secureTextEntry
                />
              </View>
            </React.Fragment>
          );
        })}

        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  keyboardType?: 'default' | 'email-address' | 'url';
}

function Field({ label, value, onChangeText, secureTextEntry, autoCapitalize, keyboardType }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize ?? 'none'}
        keyboardType={keyboardType ?? 'default'}
        autoCorrect={false}
        spellCheck={false}
        placeholderTextColor="#aaa"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  backBtn: { paddingRight: 12, paddingVertical: 4, minWidth: 70 },
  backText: { fontSize: 16, color: '#1a73e8' },
  title: { flex: 1, fontSize: 18, fontWeight: '600', color: '#111', textAlign: 'center' },
  saveBtn: { paddingLeft: 12, paddingVertical: 4, minWidth: 70, alignItems: 'flex-end' },
  saveBtnText: { fontSize: 16, color: '#1a73e8', fontWeight: '600' },
  saveBtnDisabled: { color: '#aaa' },
  saveError: { fontSize: 13, color: '#dc2626', paddingHorizontal: 16, paddingTop: 8 },
  scroll: { padding: 16 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 16,
    marginLeft: 4,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  testBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  testBtnText: { fontSize: 14, color: '#1a73e8' },
  testOk: { fontSize: 13, color: '#16a34a', marginTop: 4, marginLeft: 4 },
  testError: { fontSize: 13, color: '#dc2626', marginTop: 4, marginLeft: 4 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  switchLabel: { fontSize: 15, color: '#111' },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e5e5e5',
    marginLeft: 16,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  fieldLabel: {
    width: 90,
    fontSize: 15,
    color: '#111',
    flexShrink: 0,
  },
  fieldInput: {
    flex: 1,
    fontSize: 15,
    color: '#444',
  },
  bottomPad: { height: 40 },
});
