/**
 * Neon Data API client.
 *
 * Auth flow (no cookie jar needed — works in React Native):
 *   1. POST /sign-in/email → session cookie in Set-Cookie header
 *      If sign-in returns 4xx, auto-registers via POST /sign-up/email and retries.
 *   2. GET  /get-session   with that cookie → JWT in set-auth-jwt header
 *   3. JWT is cached in memory for 14 minutes (TTL ~15 min)
 *
 * Identity: the user supplies their own Neon Auth email + password in Settings.
 * The JWT sub claim is used by the 'authenticated' role + RLS to scope all
 * bets reads/writes to that user. user_id is never sent by the client —
 * Postgres fills it from DEFAULT (auth.user_id()) on insert.
 */

let AUTH_URL     = 'https://ep-restless-night-a6hfioss.neonauth.us-west-2.aws.neon.tech/neondb/auth';
let DATA_URL     = 'https://ep-restless-night-a6hfioss.apirest.us-west-2.aws.neon.tech/neondb/rest/v1';
let APP_EMAIL    = '';
let APP_PASSWORD = '';

let cachedJwt: { token: string; expiresAt: number } | null = null;

export function configureNeon(cfg: {
  dataUrl: string;
  authUrl: string;
  email: string;
  password: string;
}): void {
  DATA_URL     = cfg.dataUrl;
  AUTH_URL     = cfg.authUrl;
  APP_EMAIL    = cfg.email;
  APP_PASSWORD = cfg.password;
  cachedJwt    = null;
}

async function getJwt(): Promise<string> {
  // Return cached JWT if still valid with a 60s buffer.
  if (cachedJwt && Date.now() < cachedJwt.expiresAt - 60_000) {
    return cachedJwt.token;
  }

  // Step 1: sign in — credentials:'include' tells iOS's NSURLSession to store the
  // returned Set-Cookie in the native cookie store automatically.
  let signInResp = await fetch(`${AUTH_URL}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost' },
    credentials: 'include',
    body: JSON.stringify({ email: APP_EMAIL, password: APP_PASSWORD }),
  });

  // Auto-register: if sign-in fails (user doesn't exist yet), sign up then retry.
  if (!signInResp.ok) {
    const signUpResp = await fetch(`${AUTH_URL}/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost' },
      credentials: 'include',
      body: JSON.stringify({
        email: APP_EMAIL,
        password: APP_PASSWORD,
        name: APP_EMAIL,
        callbackURL: 'http://localhost',
      }),
    });

    if (!signUpResp.ok) {
      const body = await signInResp.text();
      throw new Error(`Neon Auth sign-in failed: ${signInResp.status} — ${body.slice(0, 200)}`);
    }

    // Retry sign-in now that the account exists.
    signInResp = await fetch(`${AUTH_URL}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost' },
      credentials: 'include',
      body: JSON.stringify({ email: APP_EMAIL, password: APP_PASSWORD }),
    });

    if (!signInResp.ok) {
      const body = await signInResp.text();
      throw new Error(`Neon Auth sign-in failed after sign-up: ${signInResp.status} — ${body.slice(0, 200)}`);
    }
  }

  // Step 2: get-session — the native cookie store forwards the session cookie; the
  // server responds with the JWT in the set-auth-jwt response header.
  const sessionResp = await fetch(`${AUTH_URL}/get-session`, {
    credentials: 'include',
  });

  if (!sessionResp.ok) {
    const body = await sessionResp.text().catch(() => '');
    throw new Error(`Neon Auth get-session failed: ${sessionResp.status} — ${body.slice(0, 200)}`);
  }

  const jwt = sessionResp.headers.get('set-auth-jwt');
  if (!jwt) {
    const hdrs: Record<string, string> = {};
    sessionResp.headers.forEach((v, k) => { hdrs[k] = v; });
    throw new Error(
      `Neon Auth: no JWT in get-session response. Headers: ${JSON.stringify(hdrs)}`,
    );
  }

  // Cache for 14 minutes (JWT TTL is ~15 min).
  cachedJwt = { token: jwt, expiresAt: Date.now() + 14 * 60 * 1000 };
  return jwt;
}

export interface BetRow {
  site_key:        string;
  external_bet_id: string;
  placed_at?:      string | null;
  status?:         string | null;
  stake?:          number | null;
  potential_payout?: number | null;
  selections?:     object | null;
  raw?:            object | null;
}

/**
 * Upsert bets via PostgREST merge-duplicates.
 * Idempotent on (user_id, site_key, external_bet_id); user_id is filled by
 * Postgres from auth.user_id() (the JWT sub claim) — never sent by the client.
 */
export async function upsertBets(rows: BetRow[]): Promise<void> {
  if (rows.length === 0) return;
  const jwt = await getJwt();
  const resp = await fetch(`${DATA_URL}/bets?on_conflict=user_id,site_key,external_bet_id`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`upsertBets failed: HTTP ${resp.status} — ${text.slice(0, 300)}`);
  }
}
