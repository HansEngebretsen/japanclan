/* Setup doctor — run `npm run check` after (or during) SETUP.md and it tells
   you exactly which step is done ✅ and which needs attention ❌. Safe to run
   as many times as you like; it only reads. Node 20+. */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (msg) => { pass++; console.log(`  ✅ ${msg}`); };
const bad = (msg, fix) => { fail++; console.log(`  ❌ ${msg}\n     → ${fix}`); };
const info = (msg) => console.log(`  ℹ️  ${msg}`);
const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).toString();

console.log("\njapanclan-mail setup check\n──────────────────────────");

console.log("\nLocal tools");
const major = Number(process.versions.node.split(".")[0]);
major >= 20
  ? ok(`Node ${process.versions.node}`)
  : bad(`Node ${process.versions.node} is too old`, "Install Node 20+ from nodejs.org");
existsSync("node_modules")
  ? ok("Dependencies installed")
  : bad("Dependencies not installed", "Run: npm install");

console.log("\nCloudflare");
let loggedIn = false;
try {
  const who = sh("npx wrangler whoami 2>&1");
  loggedIn = /associated with the email|You are logged in/i.test(who);
  loggedIn ? ok("Logged in to Cloudflare") : bad("Not logged in to Cloudflare", "Run: npx wrangler login  (SETUP.md step 5)");
} catch { bad("wrangler didn't run", "Run: npm install, then npx wrangler login"); }

if (loggedIn) {
  try {
    const deployments = sh("npx wrangler deployments list 2>&1");
    /Created|Version/i.test(deployments)
      ? ok("Worker is deployed")
      : bad("Worker not deployed yet", "Run: npx wrangler deploy  (SETUP.md step 5)");
  } catch { bad("Worker not deployed yet", "Run: npx wrangler deploy  (SETUP.md step 5)"); }
  try {
    const secrets = sh("npx wrangler secret list 2>&1");
    for (const name of ["GCP_SA_KEY", "GEMINI_API_KEY"]) {
      secrets.includes(name)
        ? ok(`Secret ${name} is set`)
        : bad(`Secret ${name} is missing`, `Run: npx wrangler secret put ${name}  (SETUP.md steps 3–5)`);
    }
  } catch { bad("Couldn't list secrets", "Deploy first: npx wrangler deploy"); }
  info("Email route can't be checked from here — confirm in the dashboard that");
  info("the trips subdomain catch-all sends to the japanclan-mail worker (step 6).");
}

console.log("\nFirestore (optional deeper check — needs the key file)");
const keyFile = process.env.GCP_SA_KEY_FILE;
if (!keyFile) {
  info("Skipped. To verify Firestore + config, run:");
  info("GCP_SA_KEY_FILE=~/Downloads/japanclan2k6-xxxx.json npm run check");
} else {
  try {
    const env = { GCP_SA_KEY: readFileSync(keyFile.replace(/^~/, process.env.HOME || "~"), "utf8") };
    const { getDoc } = await import("./src/firestore.js");
    const cfgDoc = await getDoc(env, "pipeline/config");
    if (!cfgDoc) {
      bad("pipeline/config doc doesn't exist", "Run: npm run seed  (SETUP.md step 7)");
    } else {
      ok("Service-account key works and pipeline/config exists");
      const cfg = cfgDoc.data;
      const senders = Object.keys(cfg.senders || {});
      senders.length
        ? ok(`Allowlisted senders: ${senders.join(", ")}`)
        : bad("No senders in the allowlist", "Firebase console → pipeline/config → senders (SETUP.md step 7)");
      const trips = Object.entries(cfg.trips || {});
      trips.length
        ? ok(`Trips configured: ${trips.map(([id, t]) => `${id} (${t.year}-${t.month}, days ${t.firstDay}–${t.lastDay})`).join("; ")}`)
        : bad("No trips configured", "Firebase console → pipeline/config → trips");
      for (const [id, t] of trips) {
        if (!t.itineraryPath) { bad(`Trip ${id} has no itineraryPath`, "Add it in pipeline/config → trips"); continue; }
        const itin = await getDoc(env, t.itineraryPath);
        itin ? ok(`Trip ${id}: itinerary doc reachable`) : info(`Trip ${id}: itinerary doc doesn't exist yet (first email will create it)`);
      }
    }
  } catch (e) {
    bad(`Firestore check failed: ${String(e).slice(0, 140)}`,
      "Re-check the service account role (Cloud Datastore User) and key file — SETUP.md step 3");
  }
}

console.log("\nGemini (optional — set GEMINI_API_KEY env var to test the key)");
if (!process.env.GEMINI_API_KEY) {
  info("Skipped. To verify: GEMINI_API_KEY=xxxx npm run check");
} else {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    res.ok ? ok("Gemini API key works") : bad(`Gemini API returned ${res.status}`, "Recreate the key at aistudio.google.com (SETUP.md step 4)");
  } catch (e) { bad(`Couldn't reach Gemini: ${e.message}`, "Check your network and try again"); }
}

console.log(`\n──────────────────────────\n${fail === 0 ? "All checks passed 🎉 — send a test email (SETUP.md step 8)!" : `${fail} thing(s) need attention above.`}\n`);
process.exit(fail === 0 ? 0 : 1);
