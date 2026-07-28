/* Setup doctor — run `npm run check` after (or during) SETUP.md and it tells
   you exactly which step is done ✅ and which needs attention ❌. Safe to run
   as many times as you like; it only reads. Node 20+. */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

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

console.log("\nGoogle Cloud / Firestore");
let gcloudOk = false;
try {
  const acct = sh("gcloud config get-value account 2>/dev/null").trim();
  if (acct && acct !== "(unset)") { ok(`Signed in to gcloud as ${acct}`); gcloudOk = true; }
  else bad("gcloud has no active account", "Run: gcloud auth login");
} catch { bad("gcloud isn't installed", "Install it: https://cloud.google.com/sdk/docs/install"); }

if (gcloudOk) {
  try {
    const sa = sh("gcloud iam service-accounts list --project=japanclan2k6 --format=value(email) 2>&1");
    sa.includes("japanclan-mail@")
      ? ok("Service account japanclan-mail exists")
      : bad("Service account japanclan-mail not found", "Run: ./setup.sh  (creates it)");
    const policy = sh("gcloud projects get-iam-policy japanclan2k6 --flatten=bindings[].members --format=value(bindings.role) --filter=bindings.members:japanclan-mail@japanclan2k6.iam.gserviceaccount.com 2>&1");
    policy.includes("roles/datastore.user")
      ? ok("Service account has Cloud Datastore User")
      : bad("Service account is missing roles/datastore.user", "Run: ./setup.sh");
  } catch (e) { bad(`Couldn't inspect the project: ${String(e).slice(0, 120)}`, "Check: gcloud config set project japanclan2k6"); }
}

{
  try {
    const { localEnv } = await import("./src/localauth.js");
    const env = localEnv();
    const { getDoc } = await import("./src/firestore.js");
    const cfgDoc = await getDoc(env, "pipeline/config");
    if (!cfgDoc) {
      bad("pipeline/config doc doesn't exist", "Run: npm run seed  (SETUP.md step 7)");
    } else {
      ok("Firestore reachable and pipeline/config exists");
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
      "Run: gcloud auth login && gcloud config set project japanclan2k6, then ./setup.sh");
  }
}

console.log("\nGemini");
if (!process.env.GEMINI_API_KEY) {
  info("Key not checkable from here (it lives in Cloudflare's secret store).");
  info("To test a key directly: GEMINI_API_KEY=xxxx npm run check");
} else {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    res.ok ? ok("Gemini API key works") : bad(`Gemini API returned ${res.status}`, "Recreate the key at aistudio.google.com (SETUP.md step 4)");
  } catch (e) { bad(`Couldn't reach Gemini: ${e.message}`, "Check your network and try again"); }
}

console.log(`\n──────────────────────────\n${fail === 0 ? "All checks passed 🎉 — send a test email (SETUP.md step 8)!" : `${fail} thing(s) need attention above.`}\n`);
process.exit(fail === 0 ? 0 : 1);
