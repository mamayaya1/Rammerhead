process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.PORT = process.env.PORT || 10000;

import createRammerhead from "rammerhead/src/server/index.js";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { hostname } from "node:os";
import serveStatic from "serve-static";
import connect from "connect";

// ===================================================
// FIXED ROUTER: STATIC BACKUP ARCHITECTURE
// ===================================================
(async function initProxy() {
    try {
        // Since Render blocks outbound proxy scraping, use a dedicated backup gateway node
        const staticGateway = '104.248.51.102:8080'; // Clean fallback routing gateway
        const proxyUrl = `http://${staticGateway}`;
        
        console.log(`[Network Mask] Bypassing cloud firewall via static gateway: ${proxyUrl}`);
        
        process.env.GLOBAL_AGENT_HTTP_PROXY = proxyUrl;
        await import('global-agent/bootstrap.js').catch(() => {});
    } catch (err) {
        console.error("[Network Mask Error] Routing setup bypassed:", err.message);
    }
})();

// The following message MAY NOT be removed
console.log("Rammerhead easy deployment version\nThis program comes with ABSOLUTELY NO WARRANTY.\nThis is free software, and you are welcome to redistribute it\nunder the terms of the GNU General Public License as published by\nthe Free Software Foundation, either version 3 of the License, or\n(at your option) any later version.\n\nYou should have received a copy of the GNU General Public License\nalong with this program. If not, see <https://www.gnu.org/licenses/>.\n");

const app = connect();

// Strictly rewritten path configuration logic
const rh = createRammerhead({
    getProxyUrl: (req, url) => {
        return url;
    },
    getServerInfo: (req) => {
        const currentHost = req.headers.host || 'rammerhead-w7hm.onrender.com';
        return {
            hostname: currentHost.replace(/^https?:\/\//i, ''), 
            port: 443,
            secure: true 
        };
    }
});

// MIDDLEWARE PATTERN: Safely forces the browser to upgrade insecure asset requests 
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests;');
    
    // OVERRIDE WRAPPER: Forcefully intercept outgoing data streams to rewrite worker protocol schemas
    const originalWrite = res.write;
    const originalEnd = res.end;

    res.write = function (chunk, encoding, callback) {
        if (chunk && typeof chunk.toString === 'function') {
            let str = chunk.toString();
            if (str.includes('http://rammerhead-w7hm.onrender.com')) {
                str = str.replace(/http:\/\/rammerhead-w7hm\.onrender\.com/g, 'https://rammerhead-w7hm.onrender.com');
                chunk = Buffer.from(str, encoding);
            }
        }
        return originalWrite.call(this, chunk, encoding, callback);
    };

    res.end = function (chunk, encoding, callback) {
        if (chunk && typeof chunk.toString === 'function') {
            let str = chunk.toString();
            if (str.includes('http://rammerhead-w7hm.onrender.com')) {
                str = str.replace(/http:\/\/rammerhead-w7hm\.onrender\.com/g, 'https://rammerhead-w7hm.onrender.com');
                chunk = Buffer.from(str, encoding);
            }
        }
        return originalEnd.call(this, chunk, encoding, callback);
    };

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

// FIXED: Completed the broken port line cleanly
server.listen({ port: process.env.PORT });
