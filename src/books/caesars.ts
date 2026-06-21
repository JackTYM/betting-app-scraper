/**
 * Caesars recipe — direct API login via AWS WAF token extracted from the WebView.
 *
 * Flow (no UI interaction required):
 *   1. WebView loads sportsbook.caesars.com — AWS WAF challenge.js runs and generates a token.
 *   2. Injected JS calls AwsWafIntegration.getToken() to retrieve the live WAF token.
 *   3. POST /pam/identity/login → idToken (Cognito JWT); handles 2FA if required.
 *   4. POST /pam/players/v1/wh-az/login with idToken → access_token + playerid (from JWT eid).
 *   5. GET /sb/v2/bets/history?status=open   → open bets.
 *   6. GET /sb/v2/bets/history?status=settled → settled bets.
 *   7. postMessage({type:'bets', ...}) back to React Native.
 *
 * MFA flow (when identity/login returns 403 ActionRequiresMfa):
 *   a. postMessage({type:'mfa', mfaId}) — React Native shows Alert.prompt.
 *   b. User enters code; RN calls injectJavaScript('window.__mfaResolve("123456")').
 *   c. PATCH /pam/identity/mfa/{mfaId}/authenticate?code={code}
 *   d. Retry POST /pam/identity/login with Mfa-Id header → idToken, then continue.
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

  POST({ type: 'debug', message: 'injected: ' + window.location.href });

  // The Caesars SPA always redirects /us/az/bet/ → / on load. If we run the
  // sync here the bets fetch gets aborted mid-flight by the redirect, which
  // clears the auth cache and triggers 2FA on the / injection. Just post
  // 'fetching' and let the / injection do the actual work.
  if (window.location.pathname.indexOf('/us/az/bet') !== -1) {
    POST({ type: 'status', state: 'fetching' });
    return;
  }

  var API = 'https://api.americanwagering.com';

  // Generate a stable device ID + footprint once, then cache in localStorage so Caesars
  // always sees the same device. Cookies from credentials:'include' requests also persist
  // automatically in WKWebView's native cookie store (incognito=false).
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  var DEV_ID = localStorage.getItem('__bl_czr_devid') || '';
  if (!DEV_ID) { DEV_ID = uuid(); localStorage.setItem('__bl_czr_devid', DEV_ID); }
  var FOOTPRINT = localStorage.getItem('__bl_czr_fp') || '';
  if (!FOOTPRINT) { FOOTPRINT = uuid(); localStorage.setItem('__bl_czr_fp', FOOTPRINT); }

  var BASE_HDR = {
    'accept':             'application/json',
    'content-type':       'application/json',
    'origin':             'https://sportsbook.caesars.com',
    'referer':            'https://sportsbook.caesars.com/',
    'x-app-version':      '7.49.0',
    'x-platform':         'cordova-desktop',
    'x-unique-device-id': DEV_ID,
  };

  // Poll until AWS WAF SDK is ready (challenge.js loads async).
  function waitForWaf(cb, n) {
    if (window.AwsWafIntegration && typeof window.AwsWafIntegration.getToken === 'function') {
      return cb();
    }
    if ((n || 0) >= 40) {
      POST({ type: 'error', message: 'WAF SDK not available after 20s' });
      return;
    }
    setTimeout(function() { waitForWaf(cb, (n || 0) + 1); }, 500);
  }

  waitForWaf(function() {
    POST({ type: 'debug', message: 'WAF ready' });

    // Guard against double-execution when the Caesars SPA does internal redirects
    // (e.g. / → /us/az/bet/) and the injected script fires multiple times in rapid
    // succession. sessionStorage persists within the same WKWebView tab session.
    var now = Date.now();
    var lastFetch = parseInt(sessionStorage.getItem('__bl_czr_last_fetch') || '0');
    if (now - lastFetch < 30000) {
      POST({ type: 'debug', message: 'skipping duplicate run (last fetch ' + Math.round((now - lastFetch) / 1000) + 's ago)' });
      return;
    }
    sessionStorage.setItem('__bl_czr_last_fetch', String(now));

    POST({ type: 'status', state: 'fetching' });

    // run(mode):
    //   false      — try cache → try refresh token → full login
    //   'refresh'  — skip cache, try refresh token → full login
    //   true       — full login only (last resort, may trigger 2FA)
    // On 401/409 during bets, we escalate: false→'refresh'→true, preserving
    // the refresh token so we can re-authenticate without a full identity login.
    async function run(mode) {
      var accessToken, playerId;

      if (mode === false) {
        var cached = null;
        try {
          cached = JSON.parse(localStorage.getItem('__bl_czr') || 'null');
          if (cached && cached.exp * 1000 < Date.now() + 60000) cached = null;
        } catch(e) { cached = null; }

        if (cached) {
          accessToken = cached.accessToken;
          playerId = cached.playerId;
          POST({ type: 'debug', message: 'using cached auth, exp=' + new Date(cached.exp * 1000).toISOString() });
        }
      }

      // Use cached idToken to get a fresh accessToken without going through identity/login.
      // idToken (from /pam/identity/login) lasts ~24h; using it skips MFA entirely.
      if (!accessToken && mode !== true) {
        var cr = null;
        try { cr = JSON.parse(localStorage.getItem('__bl_czr') || 'null'); } catch(_) {}
        var cachedIdToken = cr && cr.idToken;
        if (cachedIdToken) {
          POST({ type: 'debug', message: 'trying cached idToken' });
          try {
            var wafR = await window.AwsWafIntegration.getToken();
            var refR = await fetch(
              API + '/regions/us/locations/az/brands/czr/pam/players/v1/wh-az/login',
              {
                method: 'POST',
                headers: Object.assign({}, BASE_HDR, { 'x-aws-waf-token': wafR }),
                credentials: 'include',
                body: JSON.stringify({ token: cachedIdToken, grant_type: 'idToken' }),
              }
            );
            if (refR.ok) {
              var refD = await refR.json();
              accessToken = refD.access_token;
              var refJwt = JSON.parse(atob(accessToken.split('.')[1]));
              playerId = refJwt.eid || '';
              POST({ type: 'debug', message: 'idToken refresh OK, playerId=' + playerId });
              try {
                localStorage.setItem('__bl_czr', JSON.stringify({
                  accessToken: accessToken,
                  idToken: cachedIdToken,
                  playerId: playerId,
                  exp: refJwt.exp,
                }));
              } catch(e) {}
            } else {
              POST({ type: 'debug', message: 'idToken refresh failed: ' + refR.status + ', falling back to full login' });
              try { localStorage.removeItem('__bl_czr'); } catch(_) {}
            }
          } catch(e) {
            POST({ type: 'debug', message: 'idToken refresh error: ' + String(e) + ', falling back to full login' });
            try { localStorage.removeItem('__bl_czr'); } catch(_) {}
          }
        }
      }

      if (!accessToken) {
        // Full identity login (may trigger 2FA if device trust has lapsed).
        var waf1 = await window.AwsWafIntegration.getToken();
        var loginBody = {
          username: ${JSON.stringify(email)},
          password: ${JSON.stringify(password)},
          universe: 'wh-az',
          deviceFootprint: {
            deviceId: DEV_ID,
            footprint: FOOTPRINT,
            deviceIP: '',
            deviceType: navigator.platform || 'iPhone',
            deviceOperatingSystem: navigator.platform || 'iPhone OS',
            deviceOperatingSystemVersion: navigator.userAgent,
            appName: navigator.appName,
            appVersion: navigator.appVersion,
            appInstallationDateTime: null,
          },
        };

        var r1 = await fetch(API + '/pam/identity/login', {
          method: 'POST',
          headers: Object.assign({}, BASE_HDR, { 'x-aws-waf-token': waf1 }),
          credentials: 'include',
          body: JSON.stringify(loginBody),
        });

        // Handle MFA challenge (403 + ActionRequiresMfa)
        if (r1.status === 403) {
          var e1 = await r1.json();
          if (!e1.ActionRequiresMfa) {
            POST({ type: 'error', message: 'identity/login 403: ' + JSON.stringify(e1).substring(0, 80) });
            return;
          }
          var mfaId = e1.ActionRequiresMfa.mfaId;
          POST({ type: 'debug', message: 'MFA required, mfaId=' + mfaId });

          var mfaCode = await new Promise(function(resolve) {
            window.__mfaResolve = resolve;
            POST({ type: 'mfa', mfaId: mfaId });
          });
          POST({ type: 'debug', message: 'received MFA code' });
          POST({ type: 'status', state: 'fetching' });

          var wafMfa = await window.AwsWafIntegration.getToken();
          var mfaR = await fetch(
            API + '/pam/identity/mfa/' + mfaId + '/authenticate?code=' + mfaCode,
            { method: 'PATCH', headers: Object.assign({}, BASE_HDR, { 'x-aws-waf-token': wafMfa }), credentials: 'include' }
          );
          if (!mfaR.ok) {
            POST({ type: 'error', message: 'MFA authenticate ' + mfaR.status });
            return;
          }
          var mfaD = await mfaR.json();
          if (!mfaD.succeeded) {
            POST({ type: 'error', message: 'MFA code incorrect' });
            return;
          }
          POST({ type: 'debug', message: 'MFA verified, retrying login' });

          loginBody.deviceFootprint.footprint = null;
          r1 = await fetch(API + '/pam/identity/login', {
            method: 'POST',
            headers: Object.assign({}, BASE_HDR, { 'x-aws-waf-token': wafMfa, 'Mfa-Id': mfaId }),
            credentials: 'include',
            body: JSON.stringify(loginBody),
          });
        }

        if (!r1.ok) {
          var t1 = await r1.text();
          POST({ type: 'error', message: 'identity/login ' + r1.status + ': ' + t1.substring(0, 100) });
          return;
        }
        var d1 = await r1.json();
        var idToken = d1.idToken;
        POST({ type: 'debug', message: 'identity login OK' });

        var waf2 = await window.AwsWafIntegration.getToken();
        var r2 = await fetch(
          API + '/regions/us/locations/az/brands/czr/pam/players/v1/wh-az/login',
          {
            method: 'POST',
            headers: Object.assign({}, BASE_HDR, { 'x-aws-waf-token': waf2 }),
            credentials: 'include',
            body: JSON.stringify({ token: idToken, grant_type: 'idToken' }),
          }
        );
        if (!r2.ok) {
          var t2 = await r2.text();
          POST({ type: 'error', message: 'session/login ' + r2.status + ': ' + t2.substring(0, 100) });
          return;
        }
        var d2 = await r2.json();
        accessToken = d2.access_token;
        var jwtPayload = JSON.parse(atob(accessToken.split('.')[1]));
        playerId = jwtPayload.eid || '';
        POST({ type: 'debug', message: 'session login OK, playerId=' + playerId });

        try {
          localStorage.setItem('__bl_czr', JSON.stringify({
            accessToken: accessToken,
            idToken: idToken,
            playerId: playerId,
            exp: jwtPayload.exp,
          }));
        } catch(e) {}
      }

      // Fetch open + settled bets
      var wafBets = await window.AwsWafIntegration.getToken();
      var betHdr = Object.assign({}, BASE_HDR, {
        'authorization': 'Bearer ' + accessToken,
        'sessionid':     accessToken,
        'playerid':      playerId,
        'x-aws-waf-token': wafBets,
      });
      var BETS = API + '/regions/us/locations/az/brands/czr/sb/v2/bets/history';

      var bets = [];

      var openR = await fetch(BETS + '?status=open&page_size=50', { headers: betHdr });
      if (openR.ok) {
        var openD = await openR.json();
        (openD.bets || []).forEach(function(b) {
          bets.push(Object.assign({}, b, { _betLoaderStatus: 'open' }));
        });
      } else {
        var openErr = await openR.text();
        POST({ type: 'debug', message: 'open bets HTTP ' + openR.status + ': ' + openErr.substring(0, 300) });
        if (mode !== true && (openR.status === 401 || openR.status === 409)) {
          POST({ type: 'debug', message: 'open bets ' + openR.status + ', escalating auth' });
          try {
            var co = JSON.parse(localStorage.getItem('__bl_czr') || 'null');
            if (co && co.idToken) {
              localStorage.setItem('__bl_czr', JSON.stringify({ idToken: co.idToken }));
            } else { localStorage.removeItem('__bl_czr'); }
          } catch(_) { try { localStorage.removeItem('__bl_czr'); } catch(_) {} }
          return run(mode === false ? 'refresh' : true);
        }
      }

      var settR = await fetch(BETS + '?status=settled&page_size=50', { headers: betHdr });
      if (settR.ok) {
        var settD = await settR.json();
        (settD.bets || []).forEach(function(b) {
          bets.push(Object.assign({}, b, { _betLoaderStatus: 'settled' }));
        });
      } else {
        var settErr = await settR.text();
        POST({ type: 'debug', message: 'settled bets HTTP ' + settR.status + ': ' + settErr.substring(0, 300) });
        if (mode !== true && (settR.status === 401 || settR.status === 409)) {
          POST({ type: 'debug', message: 'settled bets ' + settR.status + ', escalating auth' });
          try {
            var cs = JSON.parse(localStorage.getItem('__bl_czr') || 'null');
            if (cs && cs.refreshToken) {
              localStorage.setItem('__bl_czr', JSON.stringify({ refreshToken: cs.refreshToken }));
            } else { localStorage.removeItem('__bl_czr'); }
          } catch(_) { try { localStorage.removeItem('__bl_czr'); } catch(_) {} }
          return run(mode === false ? 'refresh' : true);
        }
      }

      POST({ type: 'debug', message: 'done: ' + bets.length + ' bets' });
      POST({ type: 'bets', book: 'caesars', bets: bets });
    }

    run(false).catch(function(e) {
      var msg = String(e);
      // Don't clear the auth cache for navigation aborts (WKWebView cancels
      // pending fetches when a page navigates away). The cached token is still
      // valid — only explicit 401/409 responses clear it inline above.
      if (msg.indexOf('Load failed') === -1 && msg.indexOf('abort') === -1) {
        try { localStorage.removeItem('__bl_czr'); } catch(_) {}
      }
      try { sessionStorage.removeItem('__bl_czr_last_fetch'); } catch(_) {}
      POST({ type: 'error', message: 'Caesars: ' + msg });
    });
  });
})();
true;
`;
}

function mapBet(raw: Record<string, unknown>): Bet {
  const status = String(raw['_betLoaderStatus'] ?? 'open') as 'open' | 'settled';
  const { _betLoaderStatus, ...cleanRaw } = raw;
  void _betLoaderStatus;

  return {
    externalBetId: String(cleanRaw['id'] ?? ''),
    placedAt: (cleanRaw['placedAt'] as string) ?? null,
    status,
    stake: (cleanRaw['totalStake'] as number) ?? null,
    potentialPayout: (cleanRaw['potentialReturns'] as number) ?? null,
    selections: {
      eventMetadata:     cleanRaw['eventMetadata'],
      selectionMetadata: cleanRaw['selectionMetadata'],
      selectionIds:      cleanRaw['selectionIds'],
      price:             cleanRaw['price'],
      betTitle:          cleanRaw['betTitle'],
      betSubtitle:       cleanRaw['betSubtitle'],
      betType:           cleanRaw['betType'],
      type:              cleanRaw['type'],
    },
    raw: cleanRaw,
  };
}

export const caesars: BookConfig = {
  key: 'caesars',
  label: 'Caesars',
  homeUrl: 'https://sportsbook.caesars.com/us/az/bet/',
  buildInjectedJS,
  mapBet,
};
