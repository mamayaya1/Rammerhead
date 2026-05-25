// 1. ALL IMPORTS MUST BE AT THE VERY TOP
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import createRammerhead from "rammerhead/src/server/index.js";
import serveStatic from "serve-static";

// 2. ENVIRONMENT CONFIGURATIONS
process.env.PORT = process.env.PORT || 8080;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const serveStaticFiles = serveStatic(fileURLToPath(new URL("../static/", import.meta.url)));

// Configure Rammerhead Core Options
const rh = createRammerhead({
  getProxyInfo: (req) => {
    const hostHeader = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    const cleanHost = hostHeader.split(':')[0];
    return { protocol: 'https:', hostname: cleanHost, port: 443 };
  },
  getServerInfo: (req) => {
    const hostHeader = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    const cleanHost = hostHeader.split(':')[0];
    return { hostname: cleanHost, port: 443, crossDomainPort: null, crossProtoRedirect: true, protocol: 'https:' };
  }
});

// Rammerhead API routes
const rammerheadScopes = [
  "/rammerhead.js", "/hammerhead.js", "/transport-worker.js", "/task.js", "/iframe-task.js",
  "/worker-hammerhead.js", "/messaging", "/sessionexists", "/deletesession", "/newsession",
  "/editsession", "/needpassword", "/syncLocalStorage", "/api/shuffleDict", "/api/sessionexists",
  "/api/deletesession", "/api/newsession", "/api/editsession", "/api/needpassword"
];

function shouldRouteRh(req) {
  const url = new URL(req.url, 'http://' + (req.headers['host'] || 'localhost'));
  if (rammerheadScopes.includes(url.pathname)) return true;
  // Strip Rammerhead encoding suffixes like !s!utf-8, !i, !js before testing 32-char hex
  const firstSegment = url.pathname.split('/')[1] || '';
  const sessionId = firstSegment.split('!')[0];
  return /^[a-z0-9]{32}$/i.test(sessionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// EARLY PATCH SCRIPT
// Served at /rh-early-patch.js — must be loaded BEFORE hammerhead.js and
// BEFORE iframe-task.js in your HTML. It patches Object.prototype so
// addChangeEventListener exists before any Rammerhead script evaluates.
//
// Add to your static/index.html:
//   <script src="/rh-early-patch.js"></script>   ← NEW, must be first
//   <script src="/hammerhead.js"></script>
// ─────────────────────────────────────────────────────────────────────────────
const EARLY_PATCH_SCRIPT = `
(function() {
  'use strict';

  // ── 1. addChangeEventListener on Object.prototype ──────────────────────────
  // Fixes: "n.addChangeEventListener is not a function" in rammerhead.js:60
  // This fires in BOTH the main window AND inside iframes (iframe-task.js),
  // because Object.prototype is inherited everywhere.
  function attachCEL(obj) {
    if (!obj || typeof obj.addChangeEventListener === 'function') return;
    try {
      Object.defineProperty(obj, 'addChangeEventListener', {
        value: function(fn) {
          if (!this.__rhEvs) Object.defineProperty(this, '__rhEvs', {
            value: [], writable: true, configurable: true, enumerable: false
          });
          this.__rhEvs.push(fn);
        },
        enumerable: false, configurable: true, writable: true
      });
      Object.defineProperty(obj, 'removeChangeEventListener', {
        value: function(fn) {
          if (this.__rhEvs) this.__rhEvs = this.__rhEvs.filter(function(f){ return f !== fn; });
        },
        enumerable: false, configurable: true, writable: true
      });
    } catch(e) {}
  }

  attachCEL(Object.prototype);
  if (typeof Storage !== 'undefined') attachCEL(Storage.prototype);

  // ── 2. Keep the method alive on any Proxy Rammerhead creates ───────────────
  try {
    var _NP = window.Proxy;
    window.Proxy = new _NP(_NP, {
      construct: function(target, args) {
        var handler = args[1];
        if (handler) {
          var _og = handler.get;
          handler.get = function(t, prop, recv) {
            if (prop === 'addChangeEventListener') {
              return function(fn) { (t.__rhEvs = t.__rhEvs || []).push(fn); };
            }
            if (prop === 'removeChangeEventListener') {
              return function(fn) { if (t.__rhEvs) t.__rhEvs = t.__rhEvs.filter(function(f){ return f!==fn; }); };
            }
            return _og ? _og.apply(this, arguments) : Reflect.get(t, prop, recv);
          };
        }
        var p = Reflect.construct(target, args);
        attachCEL(p);
        return p;
      }
    });
  } catch(e) { console.warn('[RH-PATCH] Proxy intercept failed:', e); }

  // ── 3. navigator.onLine spoof ───────────────────────────────────────────────
  try { Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); } catch(e) {}

  // ── 4. postMessage MessagePort fix ─────────────────────────────────────────
  // Fixes: "DataCloneError: MessagePort could not be cloned because it was not transferred"
  // Hammerhead wraps postMessage and accidentally drops the transferables list.
  // We guard the native postMessage so MessagePorts are always forwarded correctly.
  var _origPM = window.postMessage;
  window.postMessage = function(msg, targetOrigin, transfer) {
    try {
      if (transfer && transfer.length) {
        return _origPM.call(window, msg, targetOrigin || '*', transfer);
      }
      return _origPM.call(window, msg, targetOrigin || '*');
    } catch(e) {
      // If hammerhead's wrapper still throws DataCloneError, send without ports
      // (reCAPTCHA degrades gracefully; better than crashing the whole page)
      try { return _origPM.call(window, msg, targetOrigin || '*'); } catch(e2) {}
    }
  };

  // ── 5. reCAPTCHA URL .match() guard ────────────────────────────────────────
  // Fixes: "Cannot read properties of undefined (reading 'match')"
  // Hammerhead rewrites URLs and sometimes produces undefined where recaptcha
  // expects a string. We patch String.prototype.match to guard against this.
  var _origMatch = String.prototype.match;
  String.prototype.match = function(pattern) {
    return _origMatch.call(this == null ? '' : this, pattern);
  };
  // Also guard on the RegExp side — reCAPTCHA sometimes calls re.exec(undefined)
  var _origExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function(str) {
    return _origExec.call(this, str == null ? '' : str);
  };
  var _origTest = RegExp.prototype.test;
  RegExp.prototype.test = function(str) {
    return _origTest.call(this, str == null ? '' : str);
  };

  console.log('[RH-EARLY-PATCH] All patches applied.');
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
// HAMMERHEAD POLYFILL — injected at the top of hammerhead.js body.
// Runs inside the proxied page context to block ad-network requests that
// cause YouTube's offline detection to trip.
// ─────────────────────────────────────────────────────────────────────────────
const HAMMERHEAD_POLYFILL = `
(function() {
  // Block ad/tracking fetches so YouTube doesn't think it's offline
  var _oF = window.fetch;
  if (_oF) {
    window.fetch = function(url, opts) {
      var s = typeof url === 'string' ? url : (url && url.href) || '';
      if (s.includes('doubleclick.net') || s.includes('googleadservices.com') || s.includes('googlesyndication.com')) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return _oF.apply(this, arguments);
    };
  }
  var _oX = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && (url.includes('doubleclick.net') || url.includes('googleadservices.com'))) {
      this.send = function() {
        Object.defineProperty(this, 'readyState',   { value: 4 });
        Object.defineProperty(this, 'status',       { value: 200 });
        Object.defineProperty(this, 'responseText', { value: '{}' });
        this.dispatchEvent(new Event('load'));
      };
      return;
    }
    return _oX.apply(this, arguments);
  };
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
// IFRAME-TASK POLYFILL — injected into iframe-task.js.
// iframe-task runs inside every proxied iframe, including reCAPTCHA's bframe.
// It needs the same addChangeEventListener patch as the main window.
// ─────────────────────────────────────────────────────────────────────────────
const IFRAME_TASK_POLYFILL = `
(function() {
  'use strict';
  // Re-apply addChangeEventListener inside every iframe context
  function attachCEL(obj) {
    if (!obj || typeof obj.addChangeEventListener === 'function') return;
    try {
      Object.defineProperty(obj, 'addChangeEventListener', {
        value: function(fn) {
          if (!this.__rhEvs) Object.defineProperty(this, '__rhEvs', {
            value: [], writable: true, configurable: true, enumerable: false
          });
          this.__rhEvs.push(fn);
        },
        enumerable: false, configurable: true, writable: true
      });
      Object.defineProperty(obj, 'removeChangeEventListener', {
        value: function(fn) {
          if (this.__rhEvs) this.__rhEvs = this.__rhEvs.filter(function(f){ return f !== fn; });
        },
        enumerable: false, configurable: true, writable: true
      });
    } catch(e) {}
  }
  attachCEL(Object.prototype);
  if (typeof Storage !== 'undefined') attachCEL(Storage.prototype);

  // postMessage MessagePort passthrough inside iframes
  if (typeof window !== 'undefined' && window.postMessage) {
    var _pm = window.postMessage;
    window.postMessage = function(msg, origin, transfer) {
      try {
        return transfer && transfer.length
          ? _pm.call(window, msg, origin || '*', transfer)
          : _pm.call(window, msg, origin || '*');
      } catch(e) {
        try { _pm.call(window, msg, origin || '*'); } catch(e2) {}
      }
    };
  }

  // String/RegExp guard for reCAPTCHA .match() on undefined
  var _om = String.prototype.match;
  String.prototype.match = function(p) { return _om.call(this == null ? '' : this, p); };
  var _oe = RegExp.prototype.exec;
  RegExp.prototype.exec = function(s) { return _oe.call(this, s == null ? '' : s); };
  var _ot = RegExp.prototype.test;
  RegExp.prototype.test = function(s) { return _ot.call(this, s == null ? '' : s); };
})();
`;

// Helper: prepend a string to the first chunk of an HTTP response
function injectBeforeScript(res, injection) {
  const _write = res.write.bind(res);
  const _end   = res.end.bind(res);
  let done = false;

  const _origSet = res.setHeader.bind(res);
  res.setHeader = function(name, value) {
    const n = name.toLowerCase();
    if (n === 'content-length') return;
    if (n === 'content-encoding') return _origSet(name, 'identity');
    return _origSet(name, value);
  };
  res.writeHead = function(code, headers) {
    if (headers) {
      delete headers['content-length'];
      delete headers['Content-Length'];
      headers['content-encoding'] = 'identity';
    }
    return Object.getPrototypeOf(res).writeHead.apply(res, arguments);
  };

  const prepend = (chunk) => {
    const prefix = Buffer.from(injection, 'utf-8');
    if (!chunk) return prefix;
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
    return Buffer.concat([prefix, body]);
  };

  res.write = function(chunk, enc, cb) {
    if (!done) { done = true; return _write(prepend(chunk), enc, cb); }
    return _write(chunk, enc, cb);
  };
  res.end = function(chunk, enc, cb) {
    if (!done) {
      done = true;
      if (typeof chunk === 'function')    { cb = chunk; chunk = null; enc = null; }
      else if (typeof enc === 'function') { cb = enc; enc = null; }
      return _end(prepend(chunk), enc || 'utf-8', cb);
    }
    return _end(chunk, enc, cb);
  };
}

// 3. SERVER
const server = createServer((req, res) => {
  // Status endpoint
  if (req.url === '/mainport') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(process.env.PORT || 8080));
  }

  // Early patch — load BEFORE hammerhead.js in your HTML
  if (req.url === '/rh-early-patch.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(EARLY_PATCH_SCRIPT);
  }

  if (shouldRouteRh(req)) {
    req.headers['x-forwarded-proto'] = 'https';
    req.connection.encrypted = true;
    if (req.headers['x-forwarded-host']) {
      req.headers['host'] = req.headers['x-forwarded-host'];
    }

    const p = req.url;

    // Inject ad-block polyfill into hammerhead.js (proxied page context)
    if (/\/hammerhead\.js(\?|$)/.test(p)) {
      injectBeforeScript(res, HAMMERHEAD_POLYFILL);
    }
    // Inject CEL + postMessage + match guard into iframe-task.js
    // This is what makes reCAPTCHA's bframe work correctly
    else if (/\/iframe-task\.js(\?|$)/.test(p)) {
      injectBeforeScript(res, IFRAME_TASK_POLYFILL);
    }

    return rh.emit("request", req, res);
  }

  serveStaticFiles(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found');
  });
});

server.on("upgrade", (req, socket, head) => {
  req.headers['x-forwarded-proto'] = 'https';
  if (req.headers['x-forwarded-host']) req.headers['host'] = req.headers['x-forwarded-host'];
  if (shouldRouteRh(req)) {
    rh.emit("upgrade", req, socket, head);
  } else {
    socket.end();
  }
});

server.on("listening", () => {
  const addr = server.address();
  console.log(`🚀 Server running on port ${addr.port}`);
});

server.listen({ port: process.env.PORT });
