import createRammerhead from "rammerhead/src/server/index.js";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { hostname, networkInterfaces } from "node:os"; // Added networkInterfaces
import serveStatic from "serve-static";
import connect from "connect";

// The following message MAY NOT be removed
console.log("Rammerhead easy deployment version\nThis program comes with ABSOLUTELY NO WARRANTY.\nThis is free software, and you are welcome to redistribute it\nunder the terms of the GNU General Public License as published by\nthe Free Software Foundation, either version 3 of the License, or\n(at your option) any later version.\n\nYou should have received a copy of the GNU General Public License\nalong with this program. If not, see <https://www.gnu.org/licenses/>.\n");

const app = connect();
const rh = createRammerhead();
const server = createServer();

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

server.on("request", app);

server.on("upgrade", (req, socket, head) => {
    if (shouldRouteRh(req)) rh.emit("upgrade", req, socket, head);
    else socket.end();
});

server.on("listening", () => {
    const addr = server.address();
    
    // Dynamically look up your real numeric IPv4 Address (e.g. 192.168.1.15)
    let networkIP = hostname();
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                networkIP = net.address;
                break;
            }
        }
    }

    const portSuffix = addr.port === 80 ? "" : ":" + addr.port;

    console.log(`Server running on port ${addr.port}`);
    console.log("");
    console.log("You can now view it in your browser.");
    
    // Cleaned Up: No brackets around local loopback structures
    console.log(`Local: http://127.0.0.1${portSuffix}`);
    console.log(`Local: http://localhost${portSuffix}`);
    try {
        // Cleaned Up: Will print your numeric IP so iPhone paths map correctly
        console.log(`On Your Network: http://${networkIP}${portSuffix}`);
    } catch (err) { /* Can't find LAN interface */ }
});

// FIXED: Added host: "0.0.0.0" to open up sockets to your local Wi-Fi router network
server.listen({ 
    port: process.env.PORT || 8080,
    host: "0.0.0.0" 
});
