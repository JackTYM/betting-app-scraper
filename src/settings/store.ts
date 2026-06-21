import * as SecureStore from 'expo-secure-store';

export interface BookCredentials {
  email: string;
  password: string;
}

export interface Settings {
  neonDataUrl: string;
  neonAuthUrl: string;
  neonEmail: string;
  neonPassword: string;
  saveHistoricBets: boolean;
  books: Record<string, BookCredentials>;
}

export const DEFAULT_SETTINGS: Settings = {
  neonDataUrl:      '',
  neonAuthUrl:      '',
  neonEmail:        '',
  neonPassword:     '',
  saveHistoricBets: false,
  books: {
    fanduel:    { email: '', password: '' },
    caesars:    { email: '', password: '' },
    draftkings: { email: '', password: '' },
  },
};

const STORE_KEY = 'betloader_settings';

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await SecureStore.getItemAsync(STORE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const partial = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...partial,
      books: { ...DEFAULT_SETTINGS.books, ...partial.books },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(s));
}
