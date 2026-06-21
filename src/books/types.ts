import type { Bet } from '../bets/types';

export interface BookConfig {
  /** Matches accounts.site_key in Neon (e.g. 'fanduel', 'caesars'). */
  key: string;
  /** Display name shown in the UI. */
  label: string;
  /** URL loaded in the WebView — the SPA's authenticated home page. */
  homeUrl: string;
  /** Optional User-Agent override. Use a desktop UA when the site blocks mobile WebViews. */
  userAgent?: string;
  /**
   * When false, the injected JS runs in ALL frames (including cross-origin iframes).
   * Use this when the login form lives inside a cross-origin iframe on the login page.
   * Defaults to true (main frame only). Maps to WebView's injectedJavaScriptForMainFrameOnly.
   */
  injectedJavaScriptForMainFrameOnly?: boolean;
  /**
   * Returns the JavaScript string injected into the WebView on each page load.
   * The script wraps window.fetch to harvest auth headers from the SPA's own
   * requests, then calls the book's bet-history endpoint(s) and postMessages
   * the results back to React Native as:
   *   {type:'bets', book:'<key>', bets: <raw array>}
   *   {type:'status', state: 'awaiting-auth'|'fetching'}
   *   {type:'error', message: string}
   * Must end with `true;` (iOS WKWebView requirement).
   */
  buildInjectedJS(email: string, password: string): string;
  /** Map a raw API bet object (from the injected JS postMessage) to Bet. */
  mapBet(raw: Record<string, unknown>): Bet;
}
