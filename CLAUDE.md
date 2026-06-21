# bet-loader — Project Conventions for AI Agents

## Purpose

bet-loader is an **Expo Go React Native app** (iOS) that syncs bet histories from
FanDuel, Caesars, and DraftKings into Neon Postgres using on-device WebViews. No
backend server. No headless browser. Anti-bot is defeated by running inside a real
WKWebView on a real iPhone.

## How syncing works

1. User opens the app and taps **Sync** for a book (FanDuel, Caesars, or DraftKings).
2. A full-screen `SyncWebView` loads the book's authenticated SPA.
3. Injected JavaScript wraps `window.fetch` (or `window.WebSocket` for DraftKings) to
   harvest the SPA's own auth headers the first time the SPA makes an API call.
4. Once headers are captured (= user is logged in), the injected JS calls the
   book's bet-history endpoint(s) with `credentials:'include'` and postMessages the
   raw response back to React Native.
5. React Native maps the raw bets → `BetRow` → upserts via the Neon Data API
   (PostgREST over HTTPS, `authenticated` role, merge-duplicates).
6. A local `expo-notifications` reminder fires 6 hours after the last sync.

Stack: Expo Go → WKWebView → injected JS → book API → Neon Data API → Neon Postgres.

## Key constraints

- **Expo Go only.** No custom native modules, no dev client. Everything must work
  with the standard Expo Go app from the App Store. EAS Build for standalone is
  future scope.
- **No owner DATABASE_URL in the app.** The user enters their own Neon Auth
  email + password in Settings. The JWT maps to the `authenticated` role, which
  has SELECT/INSERT/UPDATE on `bets` only. The owner role is never used.
- **Bets are user-scoped by RLS.** `bets.user_id` (text) is set from
  `DEFAULT (auth.user_id())` on insert and enforced by the `app_rw_bets` RLS policy.
  The client never sends `user_id`; Postgres fills it from the JWT `sub` claim.
- **WebView cookies persist automatically.** `incognito={false}` and
  `sharedCookiesEnabled` keep the user logged in across app restarts so they only
  need to log in once per book.
- **FanDuel login is manual.** The FanDuel login form is inside a cross-origin
  iframe (`account.az.sportsbook.fanduel.com`). Injected JS cannot reach it.
  The user types credentials (iOS AutoFill / 1Password) in the WebView.
- **Caesars API host is dynamic.** The injected JS captures the base URL of the
  first `*.americanwagering.com` request to avoid hardcoding the subdomain.

## Neon Data API

- **Data API URL:** `https://ep-restless-night-a6hfioss.apirest.us-west-2.aws.neon.tech/neondb/rest/v1`
- **Auth URL:** `https://ep-restless-night-a6hfioss.neonauth.us-west-2.aws.neon.tech/neondb/auth`
- **JWT flow:** POST `/sign-in/email` → read `Set-Cookie` header → GET `/get-session`
  with cookie → read `set-auth-jwt` header. JWT TTL ≈ 15 min; re-sign-in when expired.
  On first use, `client.ts` auto-registers via `POST /sign-up/email` if sign-in returns 4xx.
- **Upsert:** `POST /bets?on_conflict=user_id,site_key,external_bet_id` +
  `Prefer: resolution=merge-duplicates`

## Database (Neon, project `jolly-sound-14147488`, branch `production`)

Schema: `db/schema.sql`.
Single table: `bets` with UNIQUE(user_id, site_key, external_bet_id).

```
user_id          text  — filled by DEFAULT (auth.user_id()); never sent by client
site_key         text  — 'fanduel' | 'caesars' | 'draftkings'
external_bet_id  text  — stable unique ID from the sportsbook
placed_at        timestamptz
status           text  — 'open' | 'won' | 'lost' | 'pushed' | 'void'
stake            numeric(12,2)
potential_payout numeric(12,2)
selections       jsonb
raw              jsonb
scraped_at       timestamptz
```

RLS policy `app_rw_bets` on `bets`:
```sql
USING (auth.user_id() = user_id) WITH CHECK (auth.user_id() = user_id)
```

Grants + RLS in `db/data-api-setup.sql` (already applied to production branch).

## File map

| Concern | File |
|---|---|
| Expo entry point | `index.ts` |
| Expo config | `app.json` |
| Main UI (book list + sync nav) | `App.tsx` |
| Bet type interface | `src/bets/types.ts` |
| BookConfig interface | `src/books/types.ts` |
| FanDuel recipe (injected JS + mapBet) | `src/books/fanduel.ts` |
| Caesars recipe (injected JS + mapBet) | `src/books/caesars.ts` |
| DraftKings recipe (injected JS + mapBet) | `src/books/draftkings.ts` |
| Book registry | `src/books/registry.ts` |
| WebView component + message handler | `src/webview/SyncWebView.tsx` |
| Neon Auth + Data API client | `src/neon/client.ts` |
| Settings storage (SecureStore) | `src/settings/store.ts` |
| Settings UI | `src/settings/SettingsScreen.tsx` |
| Local notification reminder | `src/notify/reminders.ts` |
| DB schema | `db/schema.sql` |
| Data API RLS setup SQL | `db/data-api-setup.sql` |

## Adding a new betting site

1. Create `src/books/<sitekey>.ts` exporting a `BookConfig` (see `src/books/types.ts`).
2. Implement `buildInjectedJS()` — wrap `window.fetch` to harvest auth headers from
   the SPA's own requests to the book's API host, then fetch the history endpoint(s)
   and `postMessage({type:'bets', book:'<key>', bets:[...]})`.
3. Implement `mapBet(raw)` → `Bet` (see `src/bets/types.ts`).
4. Add the book to `src/books/registry.ts`.
5. No database row needed — bets are scoped by the user's Neon identity via RLS.

## Running locally

```
npx expo start
```

Open Expo Go on the iPhone, scan the QR code. No build step required.

## Secrets / credentials

Sportsbook creds and the owner DATABASE_URL are in `.dev.vars` — **never commit this file**.
The app itself uses only the credentials the user enters in Settings (their personal Neon
Auth email + password). Even if extracted from the bundle, an attacker can only read/write
that user's personal bet history (RLS enforces per-user isolation).
