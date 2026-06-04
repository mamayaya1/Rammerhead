// 1. ALL IMPORTS MUST BE AT THE VERY TOP
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import createRammerhead from "rammerhead/src/server/index.js";
import serveStatic from "serve-static";

// 2. ENVIRONMENT CONFIGURATIONS
// Use PORT from environment (Render/HuggingFace inject this), fallback to 8080 locally
process.env.PORT = process.env.PORT || 8080;

const serveStaticFiles = serveStatic(fileURLToPath(new URL("../static/", import.meta.url)));

// Configure Rammerhead Core Options
const rh = createRammerhead({
  getProxyInfo: (req) => {
    const hostHeader = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    const cleanHost = hostHeader.split(',')[0].trim().split(':')[0];
    return { protocol: 'https:', hostname: cleanHost, port: 443 };
  },
  getServerInfo: (req) => {
    const hostHeader = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    const cleanHost = hostHeader.split(',')[0].trim().split(':')[0];
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
  // Strip Rammerhead encoding suffixes (!s!utf-8, !i, !js) before testing 32-char hex session ID
  const firstSegment = url.pathname.split('/')[1] || '';
  const sessionId = firstSegment.split('!')[0];
  return /^[a-z0-9]{32}$/i.test(sessionId);
}

// Helper: force socket.encrypted = true using defineProperty
// Assignment (req.socket.encrypted = true) silently does nothing in Node 18+
// because it is a read-only getter on net.Socket.
function forceEncrypted(obj) {
  if (!obj) return;
  try {
    Object.defineProperty(obj, 'encrypted', {
      get: () => true,
      configurable: true
    });
  } catch(e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// EARLY PATCH SCRIPT — served at /rh-early-patch.js
// Must be loaded BEFORE hammerhead.js in your static/index.html:
//   <script src="/rh-early-patch.js"></script>
//   <script src="/hammerhead.js"></script>
// ─────────────────────────────────────────────────────────────────────────────
const EARLY_PATCH_SCRIPT = `
(function() {
  'use strict';

  // 1. addChangeEventListener on Object.prototype
  // Fixes: "n.addChangeEventListener is not a function" in rammerhead.js:60
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

  // 2. Keep addChangeEventListener alive on any Proxy Rammerhead creates
  try {
    var _NP = window.Proxy;
    window.Proxy = new _NP(_NP, {
      construct: function(target, args) {
        var handler = args[1];
        if (handler) {
          var _og = handler.get;
          handler.get = function(t, prop, recv) {
            if (prop === 'addChangeEventListener') return function(fn) { (t.__rhEvs = t.__rhEvs || []).push(fn); };
            if (prop === 'removeChangeEventListener') return function(fn) { if (t.__rhEvs) t.__rhEvs = t.__rhEvs.filter(function(f){ return f!==fn; }); };
            return _og ? _og.apply(this, arguments) : Reflect.get(t, prop, recv);
          };
        }
        var p = Reflect.construct(target, args);
        attachCEL(p);
        return p;
      }
    });
  } catch(e) { console.warn('[RH-PATCH] Proxy intercept failed:', e); }

  // 3. navigator.onLine spoof
  try { Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); } catch(e) {}

  // 4. postMessage MessagePort fix
  // Fixes: "DataCloneError: MessagePort could not be cloned"
  var _origPM = window.postMessage;
  window.postMessage = function(msg, targetOrigin, transfer) {
    try {
      if (transfer && transfer.length) return _origPM.call(window, msg, targetOrigin || '*', transfer);
      return _origPM.call(window, msg, targetOrigin || '*');
    } catch(e) {
      try { _origPM.call(window, msg, targetOrigin || '*'); } catch(e2) {}
    }
  };

  // 5. reCAPTCHA .match() / RegExp guard
  // Fixes: "Cannot read properties of undefined (reading 'match')"
  var _origMatch = String.prototype.match;
  String.prototype.match = function(p) { return _origMatch.call(this == null ? '' : this, p); };
  var _origExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function(s) { return _origExec.call(this, s == null ? '' : s); };
  var _origTest = RegExp.prototype.test;
  RegExp.prototype.test = function(s) { return _origTest.call(this, s == null ? '' : s); };

  // 6. BroadcastChannel polyfill (blocked in some proxy contexts)
  if (typeof BroadcastChannel === 'undefined') {
    window.BroadcastChannel = function(name) {
      this.name = name; this.onmessage = null;
      this.postMessage = function() {}; this.close = function() {};
    };
  }

  console.log('[RH-EARLY-PATCH] All patches applied.');
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
// HAMMERHEAD POLYFILL — injected into hammerhead.js
// Runs inside the proxied page context
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

  // Mobile Safari: make touch event listeners passive to unblock scroll/tap
  var _origAEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    if (type === 'touchstart' || type === 'touchmove' || type === 'wheel') {
      if (opts === undefined || opts === false) opts = { passive: true };
      else if (typeof opts === 'object' && opts.passive === undefined) opts.passive = true;
    }
    return _origAEL.call(this, type, fn, opts);
  };

  // postMessage passthrough for mobile Safari
  var _oPM = window.postMessage;
  window.postMessage = function(msg, origin, transfer) {
    try {
      if (transfer && transfer.length) return _oPM.call(window, msg, origin || '*', transfer);
      return _oPM.call(window, msg, origin || '*');
    } catch(e) {
      try { _oPM.call(window, msg, '*'); } catch(e2) {}
    }
  };
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
// IFRAME-TASK POLYFILL — injected into iframe-task.js
// Runs inside every proxied iframe (including reCAPTCHA bframe)
// ─────────────────────────────────────────────────────────────────────────────
const IFRAME_TASK_POLYFILL = `
(function() {
  'use strict';
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

  if (typeof window !== 'undefined' && window.postMessage) {
    var _pm = window.postMessage;
    window.postMessage = function(msg, origin, transfer) {
      try {
        return transfer && transfer.length
          ? _pm.call(window, msg, origin || '*', transfer)
          : _pm.call(window, msg, origin || '*');
      } catch(e) { try { _pm.call(window, msg, origin || '*'); } catch(e2) {} }
    };
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────────────────────────────────────
const server = createServer((req, res) => {

  // ── Status / port endpoint ─────────────────────────────────────────────────
  if (req.url === '/mainport') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(process.env.PORT || 8080));
  }

  // ── Debug endpoint — visit /debug in browser to inspect headers ────────────
  if (req.url === '/debug') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      nodeVersion:      process.version,
      socketEncrypted:  !!(req.socket && req.socket.encrypted),
      xForwardedProto:  req.headers['x-forwarded-proto'],
      xForwardedHost:   req.headers['x-forwarded-host'],
      host:             req.headers['host'],
      userAgent:        req.headers['user-agent'],
      remoteAddress:    req.socket && req.socket.remoteAddress,
    }, null, 2));
  }

  // ── Early patch script ─────────────────────────────────────────────────────
  if (req.url === '/rh-early-patch.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(EARLY_PATCH_SCRIPT);
  }

  // ── Proxy routing ──────────────────────────────────────────────────────────
  if (shouldRouteRh(req)) {

    // Strip security headers that Safari enforces too strictly on proxied content
    const _blockedResponseHeaders = new Set([
      'content-security-policy',
      'content-security-policy-report-only',
      'x-frame-options',
      'x-xss-protection',
      'cross-origin-opener-policy',
      'cross-origin-embedder-policy',
      'cross-origin-resource-policy',
      'permissions-policy',
    ]);
    const _origSetHeader = res.setHeader.bind(res);
    res.setHeader = function(name, value) {
      if (_blockedResponseHeaders.has(name.toLowerCase())) return;
      return _origSetHeader(name, value);
    };
    const _origWriteHead = res.writeHead;
    res.writeHead = function(code, headers) {
      if (headers) {
        for (const key of Object.keys(headers)) {
          if (_blockedResponseHeaders.has(key.toLowerCase())) delete headers[key];
        }
      }
      return _origWriteHead.apply(res, arguments);
    };

    // Add permissive CORS for mobile Safari
    _origSetHeader('Access-Control-Allow-Origin', '*');
    _origSetHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
    _origSetHeader('Access-Control-Allow-Headers', '*');
    _origSetHeader('Access-Control-Allow-Credentials', 'true');

    // Handle Safari preflight OPTIONS immediately
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    // Tell Rammerhead this is HTTPS.
    // socket.encrypted is read-only in Node 18+ — must use defineProperty.
    req.headers['x-forwarded-proto'] = 'https';
    forceEncrypted(req.socket);
    forceEncrypted(req.connection);
    if (req.socket && req.socket.socket) forceEncrypted(req.socket.socket);

    // Normalise host header
    const forwardedHost = req.headers['x-forwarded-host'];
    if (forwardedHost) {
      req.headers['host'] = forwardedHost.split(',')[0].trim();
    }

    const p = req.url;

    if (/\/hammerhead\.js(\?|$)/.test(p)) {
      injectBeforeScript(res, HAMMERHEAD_POLYFILL);
    } else if (/\/iframe-task\.js(\?|$)/.test(p)) {
      injectBeforeScript(res, IFRAME_TASK_POLYFILL);
    }

    return rh.emit("request", req, res);
  }

  // ── Static file fallback ───────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  serveStaticFiles(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found');
  });
});

server.on("upgrade", (req, socket, head) => {
  req.headers['x-forwarded-proto'] = 'https';
  forceEncrypted(socket);
  forceEncrypted(req.socket);
  forceEncrypted(req.connection);

  const forwardedHost = req.headers['x-forwarded-host'];
  if (forwardedHost) req.headers['host'] = forwardedHost.split(',')[0].trim();

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
