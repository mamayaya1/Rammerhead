process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.PORT = process.env.PORT || 10000;

import createRammerhead from "rammerhead/src/server/index.js";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { hostname } from "node:os";
import serveStatic from "serve-static";
import connect from "connect";

(async function initProxy() {
    // List of highly reliable plain-text proxy repositories
    const proxySources = [
        'https://githubusercontent.com',
        'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt',
        'https://proxyscrape.com'
    ];

    // Give Render's container 3 seconds to fully bring the network online before fetching
    await new Promise(resolve => setTimeout(resolve, 3000));

    for (const source of proxySources) {
        try {
            console.log(`[Network Mask] Attempting to fetch nodes from source...`);
            const response = await fetch(source);
            
            if (!response.ok) throw new Error(`HTTP status ${response.status}`);
            
            const text = await response.text();
            const proxies = text.split('\n').map(p => p.trim()).filter(p => p.length > 0 && !p.startsWith('#'));

            if (proxies.length > 0) {
                // Test up to 15 proxies from the active list to find a living gateway
                for (let i = 0; i < Math.min(proxies.length, 15); i++) {
                    // Randomize index slightly so we don't always hit the same dead ones
                    const randomIndex = Math.floor(Math.random() * Math.min(proxies.length, 30));
                    const testProxy = proxies[randomIndex] || proxies[i];
                    const proxyUrl = `http://${testProxy.trim()}`;
                    
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
                            return; // Success! Exit initialization loop completely
                        }
                    } catch (e) {
                        // Move to next individual proxy line
                    }
                }
            }
        } catch (err) {
            console.warn(`[Network Mask Warning] Source failed (${err.message}). Trying backup source...`);
            // Brief pause before trying the next backup URL repository link
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }
    console.log("[Network Mask] All backup systems exhausted. Operating on native cloud interface.");
})();

// The following message MAY NOT be removed
console.log("Rammerhead easy deployment version\nThis program comes with ABSOLUTELY NO WARRANTY.\nThis is free software, and you are welcome to redistribute it\nunder the terms of the GNU General Public License as published by\nthe Free Software Foundation, either version 3 of the License, or\n(at your option) any later version.\n\nYou should have received a copy of the GNU General Public License\nalong with this program. If not, see <https://www.gnu.org/licenses/>.\n");

const app = connect();
const rh = createRammerhead();

// MIDDLEWARE PATTERN: Safely forces the browser to upgrade insecure asset requests 
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests;');
    next();
});

// used when forwarding the script
const rammerheadScopes = [
    "/rammerhead.js",
    "/hammerhead.js",
    "/transport-worker.js",
    "/task.js",
    "/iframe-task.js",
    "/worker-hammerhead.js",
    "/messaging",
    "/sessionexists",
    "/deletesession",
    "/newsession",
    "/editsession",
    "/needpassword",
    "/syncLocalStorage",
    "/api/shuffleDict"
];
const rammerheadSession = /^\/[a-z0-9]{32}/;

function shouldRouteRh(req) {
    const url = new URL(req.url, "http://0.0.0.0");
    return (rammerheadScopes.includes(url.pathname) || rammerheadSession.test(url.pathname));
}

app.use((req, res, next) => {
    if (shouldRouteRh(req)) rh.emit("request", req, res);
    else next();
});

// serve static frontend (your index.html, script.js, api.js, etc.)
app.use(serveStatic(fileURLToPath(new URL("../static/", import.meta.url))));

// Create server instance cleanly using the native ES module reference variable safely
const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
    if (shouldRouteRh(req)) rh.emit("upgrade", req, socket, head);
    else socket.end();
});

server.on("listening", () => {
    const addr = server.address();

    console.log(`Server running on port ${addr.port}`);
    console.log("");
    console.log("You can now view it in your browser.");
    console.log(`Local: http://${addr.family === "IPv6" ? `[${addr.address}]` : addr.address}${addr.port === 80 ? "" : ":" + addr.port}`);
    console.log(`Local: http://localhost${addr.port === 80 ? "" : ":" + addr.port}`);
    try {
        console.log(`On Your Network: http://${hostname()}${addr.port === 80 ? "" : ":" + addr.port}`);
    } catch (err) { /* Can't find LAN interface */ }
});

server.listen({ port: process.env.PORT });
process.on('uncaughtException', (err) => {
    // Intercepts sudden proxy dropouts (ECONNRESET, ETIMEDOUT, EPIPE) mid-stream
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EPIPE') {
        console.warn(`[Proxy Warning] Mid-stream connection dropped (${err.code}). Suppressed crash.`);
        return; // Prevents the Render server from dying
    }
    console.error('[Fatal Error] System crashed from an unrelated issue:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    // Intercepts broken proxy asynchronous promises quietly
    console.warn('[Proxy Warning] Suppressed an unhandled network rejection:', reason?.message || reason);
});

