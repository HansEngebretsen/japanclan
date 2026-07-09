const bs = require('browser-sync').create();

console.log("Starting local server for mobile preview...");

bs.init({
    server: "./",
    files: ["index.html", "favicon/**/*", "sw.js", "config/**/*", "img/**/*"],
    logLevel: "silent",
    open: false,
    ui: false,
    cors: true,
    notify: false // Disable the "Connected to BrowserSync" popup in the browser
}, function(err, bs) {
    if (err) {
        console.error("Error starting Browsersync:", err);
        return;
    }
    const urls = bs.options.get("urls");
    const externalUrl = urls.get("external");
    
    console.log("\n📱 Mobile Preview URL:");
    console.log(`\x1b[36m${externalUrl}\x1b[0m\n`);
    
    console.log("Server is running. Waiting for changes...");
});
