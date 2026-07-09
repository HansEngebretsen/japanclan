const bs = require('browser-sync').create();
const net = require('net');
const os = require('os');

const PORT = 3000;

function getExternalIp() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'localhost';
}

console.log("Checking if local server is already running...");

const tester = net.createServer()
    .once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            const externalIp = getExternalIp();
            console.log(`\n📱 Server is already running on port ${PORT}.`);
            console.log("\n📱 Mobile Preview URL:");
            console.log(`\x1b[36mhttp://${externalIp}:${PORT}\x1b[0m\n`);
        }
    })
    .once('listening', () => {
        tester.once('close', () => {
            console.log("Starting local server for mobile preview...");
            bs.init({
                server: "./",
                port: PORT,
                files: ["index.html", "favicon/**/*", "sw.js", "config/**/*", "img/**/*"],
                logLevel: "silent",
                open: false,
                ui: false,
                cors: true,
                notify: false
            }, function(err, bs) {
                if (err) return console.error(err);
                const urls = bs.options.get("urls");
                console.log("\n📱 Mobile Preview URL:");
                console.log(`\x1b[36m${urls.get("external")}\x1b[0m\n`);
                console.log("Server is running. Waiting for changes...");
            });
        }).close();
    })
    .listen(PORT);

