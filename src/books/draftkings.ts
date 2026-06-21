/**
 * DraftKings recipe.
 *
 * Flow:
 *   1. WebView opens myaccount.draftkings.com/auth/login.
 *   2. Injected JS auto-fills email + password and clicks submit.
 *   3. DraftKings POSTs to accounts.draftkings.com/v1/auth/login/credentials (201 + mfaInfo).
 *   4. DraftKings renders the 2FA form in the WebView — user enters the 6-digit OTP.
 *   5. DraftKings POSTs to accounts.draftkings.com/v1/auth/login/otp (200 = success).
 *   6. Browser redirects to sportsbook.draftkings.com/sportsbook-app.
 *   7. Injected JS wraps window.WebSocket, then hard-navigates to /mybets.
 *   8. On /mybets the SPA opens wss://gateway.*.dkapis.com/…?jwt=…
 *      Our wrapper intercepts it, sends InitializeBetsPageRequest, and postMessages the bets.
 *
 * Because /mybets is loaded via window.location.href (full page reload), the injected
 * JS runs fresh there and wraps WebSocket before the SPA code executes.
 */

import type { BookConfig } from './types';
import type { Bet } from '../bets/types';

function buildInjectedJS(email: string, password: string): string {
  return `
(function() {
  if (window.__betLoader) return true;
  window.__betLoader = true;

  var POST = function(m) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch(e) {}
  };

  var href     = window.location.href;
  var hostname = window.location.hostname;
  var pathname = window.location.pathname;
  POST({ type: 'debug', message: 'DK injected: ' + href });

  // ── /mybets — WebSocket interception ──────────────────────────────────────
  if (hostname === 'sportsbook.draftkings.com' && pathname.indexOf('/mybets') !== -1) {
    POST({ type: 'status', state: 'fetching' });

    var OrigWS = window.WebSocket;
    var wsDone = false;

    window.WebSocket = function(url, protocols) {
      var ws = (protocols !== undefined) ? new OrigWS(url, protocols) : new OrigWS(url);

      if (!wsDone && url.indexOf('dkapis.com') !== -1) {
        wsDone = true;
        POST({ type: 'debug', message: 'DK: WS to ' + url.substring(0, 80) });

        ws.addEventListener('open', function() {
          POST({ type: 'debug', message: 'DK: WS open, sending InitializeBetsPageRequest' });
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'InitializeBetsPageRequest',
            id: 'bl-' + Date.now(),
            params: {
              betsRequest: {
                filter: { status: 'All' },
                pagination: { count: 100, skip: 0 },
                ScoreboardType: 'EventScore',
              },
              cashOut: { information: true, pullOperations: true },
              locale: 'en',
            },
          }));
        });

        // The SPA fires its own InitializeBetsPageRequest (count=25) and we fire ours
        // (count=100). Both responses arrive as result.initial.bets messages. Debounce
        // for 1.2s after the last message and keep the largest array so we always post
        // our full-count response rather than the SPA's smaller default response.
        var bestBets = null;
        var flushTimer = null;
        ws.addEventListener('message', function(e) {
          try {
            var data = JSON.parse(e.data);
            if (data.result && data.result.initial && Array.isArray(data.result.initial.bets)) {
              var bets = data.result.initial.bets;
              POST({ type: 'debug', message: 'DK: ' + bets.length + ' bets (candidate)' });
              if (!bestBets || bets.length > bestBets.length) bestBets = bets;
              clearTimeout(flushTimer);
              flushTimer = setTimeout(function() {
                POST({ type: 'debug', message: 'DK: posting ' + bestBets.length + ' bets' });
                POST({ type: 'bets', book: 'draftkings', bets: bestBets });
                bestBets = null;
              }, 1200);
            }
          } catch(ex) {
            POST({ type: 'debug', message: 'DK WS msg error: ' + String(ex) });
          }
        });

        ws.addEventListener('error', function(e) {
          POST({ type: 'debug', message: 'DK WS error' });
        });
      }

      return ws;
    };
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN       = OrigWS.OPEN;
    window.WebSocket.CLOSING    = OrigWS.CLOSING;
    window.WebSocket.CLOSED     = OrigWS.CLOSED;
    window.WebSocket.prototype  = OrigWS.prototype;

    return;
  }

  // ── sportsbook (post-login redirect) — hard-navigate to /mybets ───────────
  if (hostname === 'sportsbook.draftkings.com') {
    POST({ type: 'status', state: 'fetching' });
    POST({ type: 'debug', message: 'DK: sportsbook page, navigating to /mybets' });
    setTimeout(function() {
      window.location.href = 'https://sportsbook.draftkings.com/mybets';
    }, 800);
    return;
  }

  // ── login / auth pages ────────────────────────────────────────────────────
  POST({ type: 'status', state: 'awaiting-auth' });

  // Wrap fetch to log credential and OTP endpoint responses for debugging.
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    var prom = origFetch.apply(this, arguments);

    if (url.indexOf('/auth/login/credentials') !== -1) {
      prom.then(function(resp) {
        if (resp.status === 201) {
          POST({ type: 'debug', message: 'DK: credentials 201, MFA required' });
        } else {
          POST({ type: 'debug', message: 'DK: credentials HTTP ' + resp.status });
        }
      }).catch(function(){});
    }

    if (url.indexOf('/auth/login/otp') !== -1) {
      prom.then(function(resp) {
        POST({ type: 'debug', message: 'DK: otp HTTP ' + resp.status });
        if (resp.status === 200) {
          POST({ type: 'status', state: 'fetching' });
        }
      }).catch(function(){});
    }

    return prom;
  };

  // Auto-fill login form (email + password → click submit)
  function setVal(el, val) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  var submitted = false;

  function tryFill(n) {
    var email = document.querySelector('input[type="email"]');
    var pass  = document.querySelector('input[type="password"]');
    if (!email || !pass) {
      if (n < 40) setTimeout(function() { tryFill(n + 1); }, 500);
      return;
    }
    setVal(email, ${JSON.stringify(email)});
    setVal(pass,  ${JSON.stringify(password)});
    setTimeout(function() {
      if (submitted) return;
      var btn = document.getElementById('login-submit') || document.querySelector('button[type="submit"]');
      if (btn) {
        submitted = true;
        POST({ type: 'debug', message: 'DK: login submit clicked' });
        btn.click();
      }
    }, 600);
  }

  if (hostname === 'myaccount.draftkings.com') {
    tryFill(0);
  }
})();
true;
`;
}

function mapBet(raw: Record<string, unknown>): Bet {
  const status           = String(raw['status'] ?? '');
  const settlementStatus = String(raw['settlementStatus'] ?? '').toLowerCase();

  let mappedStatus: string | null;
  if (status === 'Open') {
    mappedStatus = 'open';
  } else if (status === 'Settled') {
    if      (settlementStatus === 'won')                            mappedStatus = 'won';
    else if (settlementStatus === 'lost')                           mappedStatus = 'lost';
    else if (settlementStatus === 'push')                           mappedStatus = 'pushed';
    else if (settlementStatus === 'void' || settlementStatus === 'cancelled') mappedStatus = 'void';
    else                                                            mappedStatus = settlementStatus || null;
  } else {
    mappedStatus = status.toLowerCase() || null;
  }

  return {
    externalBetId:   String(raw['betId'] ?? ''),
    placedAt:        (raw['placementDate'] as string) ?? null,
    status:          mappedStatus,
    stake:           (raw['stake'] as number) ?? null,
    potentialPayout: (raw['potentialReturns'] as number) ?? null,
    selections: {
      type:       raw['type'],
      selections: raw['selections'],
    },
    raw,
  };
}

export const draftkings: BookConfig = {
  key:     'draftkings',
  label:   'DraftKings',
  homeUrl: 'https://myaccount.draftkings.com/auth/login?product=sportsbook&intendedSiteExp=US-AZ-SB&returnPath=https%3A%2F%2Fsportsbook.draftkings.com%2F',
  buildInjectedJS,
  mapBet,
};
