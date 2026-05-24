process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.PORT = process.env.PORT || 10000;

import createRammerhead from "rammerhead/src/server/index.js";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { hostname } from "node:os";
import serveStatic from "serve-static";
import connect from "connect";

// ===================================================
// AUTOMATED PROXY SCRAPER (Unrestricted Environments)
// ===================================================
(async function initProxy() {
    const proxySources = [
        'https://githubusercontent.com',
        'https://jsdelivr.net',
        'https://githubusercontent.com'
    ];

    // Brief startup pause
    await new Promise(resolve => setTimeout(resolve, 2000));

    for (const source of proxySources) {
        try {
            console.log(`[Network Mask] Fetching plain-text nodes...`);
            const response = await fetch(source);
            
            if (!response.ok) throw new Error(`HTTP status code ${response.status}`);
            
            const text = await response.text();
            
            // HTML GUARD: Safely filters out web page layouts
            if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('<head')) {
                throw new Error("Source returned an HTML web page instead of a raw text IP list.");
            }

            const proxies = text.replace(/\r/g, '').split('\n')
                                .map(p => p.trim())
                                .filter(p => p.length > 0 && !p.startsWith('#') && p.includes(':'));

            if (proxies.length > 0) {
                for (let i = 0; i < Math.min(proxies.length, 15); i++) {
                    const randomIndex = Math.floor(Math.random() * Math.min(proxies.length, 40));
                    const testProxy = proxies[randomIndex] || proxies[i];
                    
                    const cleanIP = testProxy.replace(/^https?:\/\//i, '').trim();
                    const proxyUrl = `http://${cleanIP}`;
                    
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 1800);

                        const check = await fetch('https://google.com', {
                            signal: controller.signal,
                            headers: { 'User-Agent': 'Mozilla/5.0' }
                        });
                        
                        clearTimeout(timeoutId);

                        if (check.ok) {
                            console.log(`[Network Mask] Verified clean path link established: ${proxyUrl}`);
                            process.env.GLOBAL_AGENT_HTTP_PROXY = proxyUrl;
                            await import('global-agent/bootstrap.js').catch(() => {});
                            return; 
                        }
                    } catch (e) {}
                }
            }
        } catch (err) {
            console.warn(`[Network Mask Warning] Source bypassed (${err.message}). Trying backup...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    console.log("[Network Mask] Active routing pools exhausted. Operating natively.");
})();

console.log("Rammerhead easy deployment version\nThis program comes with ABSOLUTELY NO WARRANTY.\n");

const app = connect();

const rh = createRammerhead({
    getProxyUrl: (req, url) => {
        return url;
    },
    getServerInfo: (req) => {
        // DYNAMIC: Reads your active Codespace domain automatically
        const currentHost = req.headers.host || 'localhost';
        return {
            hostname: currentHost.replace(/^https?:\/\//i, ''), 
            port: 443,
            secure: true 
        };
    }
});

// MIDDLEWARE PATTERN: Automatically updates protocols for whatever domain you use
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests;');
    
    const originalWrite = res.write;
    const originalEnd = res.end;

    res.write = function (chunk, encoding, callback) {
        if (chunk && typeof chunk.toString === 'function') {
            let str = chunk.toString();
            const host = req.headers.host;
            if (host && str.includes(`http://${host}`)) {
                const regex = new RegExp(`http://${host.replace(/\./g, '\\.')}`, 'g');
                str = str.replace(regex, `https://${host}`);
                chunk = Buffer.from(str, encoding);
            }
        }
        return originalWrite.call(this, chunk, encoding, callback);
    };

    res.end = function (chunk, encoding, callback) {
        if (chunk && typeof chunk.toString === 'function') {
            let str = chunk.toString();
            const host = req.headers.host;
            if (host && str.includes(`http://${host}`)) {
                const regex = new RegExp(`http://${host.replace(/\./g, '\\.')}`, 'g');
                str = str.replace(regex, `https://${host}`);
                chunk = Buffer.from(str, encoding);
            }
        }
        return originalEnd.call(this, chunk, encoding, callback);
    };

    next();
});

const rammerheadScopes = [
    "/rammerhead.js", "/hammerhead.js", "/transport-worker.js", "/task.js",
    "/iframe-task.js", "/worker-hammerhead.js", "/messaging", "/sessionexists",
    "/deletesession", "/newsession", "/editsession", "/needpassword",
    "/syncLocalStorage", "/api/shuffleDict"
];
const rammerheadSession = /^\/[a-z0-9]{32}/;

function shouldRouteRh(req) {
    const url = new URL(req.url, "http://0.0.0");
    return (rammerheadScopes.includes(url.pathname) || rammerheadSession.test(url.pathname));
}

app.use((req, res, next) => {
    if (shouldRouteRh(req)) rh.emit("request", req, res);
    else next();
});

app.use(serveStatic(fileURLToPath(new URL("../static/", import.meta.url))));

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
    if (shouldRouteRh(req)) rh.emit("upgrade", req, socket, head);
    else socket.end();
});

server.on("listening", () => {
    const addr = server.address();
    console.log(`Server running on port ${addr.port}`);
});

server.listen({ port: process.env.PORT });
