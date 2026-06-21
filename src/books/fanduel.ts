/**
 * FanDuel recipe.
 *
 * Flow:
 *   1. WebView opens https://az.sportsbook.fanduel.com/login.
 *   2. Script runs in the login page (top frame) AND in the account.az iframe.
 *      - Top frame: watches for __fd_ok postMessage and does URL-based detection.
 *      - Iframe: wraps window.fetch to intercept POST /sessions (201 = login OK,
 *        401 + MFA.1 = 2FA required). On 201, sends __fd_ok to the top frame.
 *      - Iframe: auto-fills credentials and clicks submit.
 *   3. Top frame receives __fd_ok (or detects a non-/login FD URL) → navigates to /my-bets.
 *   4. On /my-bets the SPA makes its first GET /sbapi/fetch-my-bets call.
 *      The fetch interceptor captures auth headers and calls fetchAllBets().
 *   5. fetchAllBets() paginates open + settled bets, then postMessages the result.
 *
 * Note: window.ReactNativeWebView is only available in the top frame (WKWebView
 * sets it up for the main frame only). POST() calls from the iframe fail silently,
 * which is fine — navigation uses window.parent.postMessage instead.
 */

import type { BookConfig } from './types';
import type { Bet } from '../bets/types';

const API_HOST   = 'api.sportsbook.fanduel.com';
const AK         = 'FhMFpcPWXMeyZxOx';
const BETS_URL   = `https://${API_HOST}/sbapi/fetch-my-bets`;
const ORIGIN     = 'https://az.sportsbook.fanduel.com';
const PAGE_SIZE  = 20;
const MAX_OPEN_PAGES    = 10;
const MAX_SETTLED_PAGES = 10;

function buildInjectedJS(email: string, password: string): string {
  return `
(function() {
  if (window.__betLoader) return true;
  window.__betLoader = true;

  var isTop = (window === window.top);

  var POST = function(m) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch(e) {}
  };

  POST({ type: 'debug', message: 'FD injected: ' + window.location.href + (isTop ? '' : ' [iframe]') });

  function flatHeaders(h) {
    if (!h) return {};
    var out = {};
    if (typeof h.forEach === 'function') { h.forEach(function(v,k){ out[k.toLowerCase()]=v; }); return out; }
    if (Array.isArray(h)) { h.forEach(function(p){ out[p[0].toLowerCase()]=p[1]; }); return out; }
    Object.keys(h).forEach(function(k){ out[k.toLowerCase()]=h[k]; });
    return out;
  }

  var origFetch = window.fetch;

  if (isTop) {
    // ── TOP FRAME ───────────────────────────────────────────────────────────────
    var captured = null;

    function snapshotLocalStorage() {
      try {
        var lsData = {};
        for (var ki = 0; ki < localStorage.length; ki++) {
          var lk = localStorage.key(ki);
          if (lk) lsData[lk] = localStorage.getItem(lk) || '';
        }
        POST({ type: 'localStorage', data: lsData });
      } catch(e) {}
    }

    // Relay postMessages from the iframe (which can't reach ReactNativeWebView)
    // so we can see what the account.az iframe is doing in RN logs.
    window.addEventListener('message', function(e) {
      try {
        if (e.data && e.data.__fd_relay) POST(e.data.payload);
      } catch(_) {}
    });

    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      var prom = origFetch.apply(this, arguments);

      // Log every fetch to any fanduel-related host so we can see what the SPA
      // is calling and whether x-authentication is present.
      if (url.indexOf('fanduel.com') !== -1) {
        var dbgH = init ? flatHeaders(init.headers) : {};
        var dbgKeys = Object.keys(dbgH);
        POST({
          type: 'debug',
          message: 'FD fetch: ' + url.replace('https://', '').substring(0, 70) +
            ' | init=' + !!init +
            ' | headers=[' + dbgKeys.join(',') + ']' +
            ' | x-auth=' + !!dbgH['x-authentication']
        });
      }

      // Harvest auth headers from the SPA's first authenticated call to the sportsbook API.
      if (!captured && url.indexOf('${API_HOST}') !== -1) {
        if (!init) {
          POST({ type: 'debug', message: 'FD: hit api.sportsbook but init is null/undefined' });
        } else {
          var h = flatHeaders(init.headers);
          if (h['x-authentication']) {
            captured = {
              'x-authentication':    h['x-authentication'],
              'x-px-context':        h['x-px-context'] || '',
              'x-application':       h['x-application'] || '${AK}',
              'x-sportsbook-region': h['x-sportsbook-region'] || 'AZ',
              'x-app-version':       h['x-app-version'] || '',
            };
            POST({ type: 'debug', message: 'FD: auth headers captured' });
            POST({ type: 'status', state: 'fetching' });
            snapshotLocalStorage();
            fetchAllBets();
          } else {
            POST({ type: 'debug', message: 'FD: hit api.sportsbook but no x-authentication. headers=[' + Object.keys(h).join(',') + ']' });
          }
        }
      }

      return prom;
    };

    // ── XHR interception (FD uses XHR for sportsbook API calls, not fetch) ───────
    var OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
      var xhr = new OrigXHR();
      var xhrUrl = '';
      var xhrHeaders = {};
      var origOpen = xhr.open.bind(xhr);
      var origSetHeader = xhr.setRequestHeader.bind(xhr);
      var origSend = xhr.send.bind(xhr);
      xhr.open = function(method, url) {
        xhrUrl = String(url || '');
        xhrHeaders = {};
        return origOpen.apply(xhr, arguments);
      };
      xhr.setRequestHeader = function(name, value) {
        xhrHeaders[name.toLowerCase()] = String(value || '');
        return origSetHeader.apply(xhr, arguments);
      };
      xhr.send = function() {
        if (xhrUrl.indexOf('fanduel.com') !== -1) {
          var xKeys = Object.keys(xhrHeaders);
          POST({
            type: 'debug',
            message: 'FD XHR: ' + xhrUrl.replace('https://', '').substring(0, 70) +
              ' | headers=[' + xKeys.join(',') + ']' +
              ' | x-auth=' + !!xhrHeaders['x-authentication']
          });
          if (!captured && xhrUrl.indexOf('${API_HOST}') !== -1 && xhrHeaders['x-authentication']) {
            captured = {
              'x-authentication':    xhrHeaders['x-authentication'],
              'x-px-context':        xhrHeaders['x-px-context'] || '',
              'x-application':       xhrHeaders['x-application'] || '${AK}',
              'x-sportsbook-region': xhrHeaders['x-sportsbook-region'] || 'AZ',
              'x-app-version':       xhrHeaders['x-app-version'] || '',
            };
            POST({ type: 'debug', message: 'FD: auth headers captured via XHR' });
            POST({ type: 'status', state: 'fetching' });
            snapshotLocalStorage();
            fetchAllBets();
          }
        }
        return origSend.apply(xhr, arguments);
      };
      return xhr;
    };
    window.XMLHttpRequest.prototype = OrigXHR.prototype;

    // ── Route based on current URL ─────────────────────────────────────────────
    var href = window.location.href;
    if (href.indexOf('/login') !== -1 || href.indexOf('az.sportsbook.fanduel.com') === -1) {
      POST({ type: 'debug', message: 'FD: login page, awaiting auth' });
      POST({ type: 'status', state: 'awaiting-auth' });
    } else {
      POST({ type: 'debug', message: 'FD: post-login page (' + href + '), awaiting SPA fetch' });
      POST({ type: 'status', state: 'fetching' });
    }

    // Dump localStorage after 2s to see what FD stores for auth/session.
    setTimeout(function() {
      try {
        var lsKeys = [];
        var lsJwt = [];
        for (var ki = 0; ki < localStorage.length; ki++) {
          var lk = localStorage.key(ki) || '';
          lsKeys.push(lk);
          var lv = localStorage.getItem(lk) || '';
          if (lv.indexOf('eyJ') !== -1 || lv.indexOf('access_token') !== -1 || lv.indexOf('auth') !== -1) {
            lsJwt.push(lk + '=' + lv.substring(0, 60));
          }
        }
        POST({ type: 'debug', message: 'FD localStorage(' + lsKeys.length + '): ' + lsKeys.join(',') });
        if (lsJwt.length > 0) {
          POST({ type: 'debug', message: 'FD localStorage auth values: ' + lsJwt.join(' | ') });
        }
      } catch(e) { POST({ type: 'debug', message: 'FD localStorage error: ' + String(e) }); }
    }, 2000);

    // ── Balance watch — detect already-logged-in state via DOM ─────────────────
    // When cookies keep the user logged in, FD SPA navigates /login → / without
    // making x-authentication calls. We watch for the account-summary balance
    // text ($xxx.xx) as the signal auth is established, then navigate to /my-bets
    // where the SPA fires authenticated sportsbook API calls our wrapper captures.
    // If only the person icon (SVG) is visible the user isn't logged in — stay put.
    var balancePollN = 0;
    var inAuthLast = false;
    var balancePoll = setInterval(function() {
      if (captured) { clearInterval(balancePoll); return; }

      // Detect whether the login/2FA iframe is currently visible.
      // While it is, the user is mid-auth — pause the countdown and stay quiet.
      var frames = document.querySelectorAll('iframe');
      var inAuth = false;
      for (var fi = 0; fi < frames.length; fi++) {
        if ((frames[fi].src || '').indexOf('account.az') !== -1) { inAuth = true; break; }
      }
      if (inAuth !== inAuthLast) {
        POST({ type: 'debug', message: 'FD: auth iframe ' + (inAuth ? 'appeared (login/2FA active, pausing poll count)' : 'gone (auth complete, resuming)') });
        inAuthLast = inAuth;
      }
      if (inAuth) return; // don't count, don't navigate while user is in auth flow

      if (++balancePollN > 60) { // 30s of post-auth idle time
        POST({ type: 'debug', message: 'FD: balance poll timed out (30s post-auth, no balance detected)' });
        clearInterval(balancePoll);
        return;
      }
      var link = document.querySelector('a[href="/account-summary"]');
      if (balancePollN % 10 === 0) {
        POST({ type: 'debug', message: 'FD: balance poll #' + balancePollN + ' on ' + window.location.pathname + ' | link=' + !!link + ' | text=' + (link ? (link.textContent || '').trim().substring(0, 30) : 'n/a') });
      }
      if (!link) return;
      var text = link.textContent || '';
      if (text.indexOf('$') !== -1) {
        clearInterval(balancePoll);
        if (window.location.pathname.indexOf('/my-bets') !== -1) {
          POST({ type: 'debug', message: 'FD: balance detected on /my-bets, staying put, awaiting sportsbook XHR' });
          return;
        }
        POST({ type: 'debug', message: 'FD: balance detected (' + text.trim().substring(0, 20) + '), SPA-navigating to /my-bets' });
        var mbLink = document.querySelector('a[href="/my-bets"]');
        if (mbLink) {
          mbLink.click();
        } else {
          var tmp = document.createElement('a');
          tmp.setAttribute('href', '/my-bets');
          document.body.appendChild(tmp);
          tmp.click();
          document.body.removeChild(tmp);
        }
      }
    }, 500);

    // ── Fetch all bets once auth headers are captured ──────────────────────────
    // Use OrigXHR (not fetch) because FD's API returns CORS headers suited for
    // XHR-based requests; window.fetch with cross-origin calls gets rejected.
    function xhrGet(url) {
      return new Promise(function(resolve, reject) {
        var xhr = new OrigXHR();
        xhr.open('GET', url);
        Object.keys(captured).forEach(function(k) { xhr.setRequestHeader(k, captured[k]); });
        xhr.onload = function() {
          resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, text: xhr.responseText });
        };
        xhr.onerror = function() { reject(new Error('XHR network error')); };
        xhr.ontimeout = function() { reject(new Error('XHR timeout')); };
        xhr.send();
      });
    }

    function fetchAllBets() {
      (async function() {
        try {
          var bets = [];

          // Open bets (paginated)
          for (var p = 1; p <= ${MAX_OPEN_PAGES}; p++) {
            var from = (p - 1) * ${PAGE_SIZE} + 1;
            var to   = p * ${PAGE_SIZE};
            var r = await xhrGet(
              '${BETS_URL}?isSettled=false&fromRecord=' + from + '&toRecord=' + to +
              '&sortDir=DESC&sortParam=PLACEMENT_DATE' +
              '&adaptiveTokenEnabled=false&rewardsClubEnabled=false&_ak=${AK}'
            );
            if (!r.ok) { POST({ type: 'debug', message: 'FD open page ' + p + ' HTTP ' + r.status }); break; }
            var d = JSON.parse(r.text);
            bets = bets.concat(d.bets || []);
            if (!d.moreAvailable) break;
          }

          // Settled bets (paginated)
          for (var q = 1; q <= ${MAX_SETTLED_PAGES}; q++) {
            var sf = (q - 1) * ${PAGE_SIZE} + 1;
            var st = q * ${PAGE_SIZE};
            var sr = await xhrGet(
              '${BETS_URL}?isSettled=true&fromRecord=' + sf + '&toRecord=' + st +
              '&sortDir=DESC&sortParam=SETTLEMENT_DATE' +
              '&adaptiveTokenEnabled=false&rewardsClubEnabled=false&_ak=${AK}'
            );
            if (!sr.ok) { POST({ type: 'debug', message: 'FD settled page ' + q + ' HTTP ' + sr.status }); break; }
            var sd = JSON.parse(sr.text);
            bets = bets.concat(sd.bets || []);
            if (!sd.moreAvailable) break;
          }

          POST({ type: 'debug', message: 'FD: ' + bets.length + ' bets total' });
          POST({ type: 'bets', book: 'fanduel', bets: bets });
        } catch(e) {
          POST({ type: 'error', message: 'FD fetchAllBets: ' + String(e) });
        }
      })();
    }

  } else {
    // ── IFRAME (account.az.sportsbook.fanduel.com) ─────────────────────────────
    // ReactNativeWebView is not available in cross-origin iframes. Redefine POST
    // to relay messages to the top frame, which forwards them to RN via onMessage.
    POST = function(m) {
      try { window.parent.postMessage({ __fd_relay: true, payload: m }, '*'); } catch(e) {}
    };

    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      var prom = origFetch.apply(this, arguments);

      if (url.indexOf('api.fanduel.com/sessions') !== -1) {
        prom.then(function(resp) {
          var status = resp.status;
          resp.clone().json().then(function(data) {
            if (status === 401) {
              var err = data.errors && data.errors[0];
              if (err && err.error_code === 'MFA.1') {
                // FanDuel's native UI shows the 2FA code input — nothing to do here.
                POST({ type: 'debug', message: 'FD: 2FA required' });
              }
            } else if (status === 201) {
              POST({ type: 'debug', message: 'FD: login OK — FD SPA will navigate, fetch wrapper will capture' });
              // No explicit navigation: FD's SPA navigates to / after sessions 201
              // (client-side route change, same JS context as /login). The top
              // frame's fetch wrapper stays active and captures auth headers from
              // the SPA's first authenticated call on /, triggering fetchAllBets().
            }
          }).catch(function(){});
        });
      }

      return prom;
    };

    // Auto-fill credentials on the login form.
    var href = window.location.href;
    if (href.indexOf('/login') !== -1 || href.indexOf('account.az') !== -1) {
      var submitted = false;

      function setVal(el, val) {
        var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function tryFill(n) {
        var email = document.getElementById('email-address') || document.querySelector('input[type="email"]');
        var pass  = document.getElementById('password')       || document.querySelector('input[type="password"]');
        if (!email || !pass) {
          if (n < 40) setTimeout(function() { tryFill(n + 1); }, 500);
          return;
        }
        setVal(email, ${JSON.stringify(email)});
        setVal(pass,  ${JSON.stringify(password)});
        setTimeout(function() {
          if (submitted) return;
          var btn = document.querySelector('[data-test-id="button-submit"]');
          if (btn) {
            submitted = true;
            btn.click();
            POST({ type: 'debug', message: 'FD: submit clicked' });
          }
        }, 600);
      }
      tryFill(0);
    }
  }
})();
true;
`;
}

function mapBet(raw: Record<string, unknown>): Bet {
  let status: string | null;
  if (!raw['isSettled']) {
    status = 'open';
  } else {
    const r = String(raw['result'] ?? '').toUpperCase();
    if      (r === 'WON')                        status = 'won';
    else if (r === 'LOST')                       status = 'lost';
    else if (r === 'PUSH')                       status = 'pushed';
    else if (r === 'VOID' || r === 'CANCELLED')  status = 'void';
    else                                         status = r.toLowerCase() || null;
  }
  return {
    externalBetId:   String(raw['betId'] ?? ''),
    placedAt:        (raw['placedDate'] as string) ?? null,
    status,
    stake:           (raw['currentSize'] as number) ?? null,
    potentialPayout: (raw['potentialWin'] as number) ?? (raw['originalPotentialWin'] as number) ?? null,
    selections:      { betType: raw['betType'], legs: raw['legs'] },
    raw,
  };
}

export const fanduel: BookConfig = {
  key:      'fanduel',
  label:    'FanDuel',
  homeUrl:  'https://az.sportsbook.fanduel.com/login',
  injectedJavaScriptForMainFrameOnly: false,
  buildInjectedJS,
  mapBet,
};
