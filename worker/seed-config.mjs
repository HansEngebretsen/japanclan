/* One-time seeder for the pipeline/config doc — run from worker/:
     GCP_SA_KEY_FILE=~/Downloads/japanclan2k6-xxxx.json npm run seed
   Refuses to overwrite an existing config. Node 20+. */

import { getDoc, setDoc } from "./src/firestore.js";
import { localEnv } from "./src/localauth.js";

const env = localEnv();

const STARTER = {
  senders: {
    "engebretsenh@gmail.com": { name: "Hans", trip: "japan-2026" },
  },
  addresses: {
    // trip@ is the generic address and the one Cloudflare actually routes.
    // Events land in whichever trip's date window contains them, so a single
    // address serves every trip; this mapping is only the tie-break default.
    "trip@trips.haaans.com": "japan-2026",
    "japan@trips.haaans.com": "japan-2026",
  },
  trips: {
    "japan-2026": {
      year: 2026,
      month: 7,
      firstDay: 12,
      lastDay: 25,
      defaultTz: "GMT+9",
      tzOffset: "+09:00",
      itineraryPath: "trips/japan-2026/config/itinerary",
    },
  },
  llm: {
    // Google retires models and they start returning 404 "no longer available
    // to new users" — the 2.5-flash pair that shipped here originally both did.
    // Switchable in Firestore without a redeploy when it happens again.
    model: "gemini-3.5-flash",
    fallbackModel: "gemini-3.1-flash-lite",
    maxInputChars: 8000,
    // promptTemplate: ""   ← optional override; the worker has a good default built in
  },
  options: {
    replyOnSuccess: true,
    replyOnFailure: true,
    archiveTo: "engebretsenh@gmail.com",
  },
};

const existing = await getDoc(env, "pipeline/config");
if (existing) {
  console.log("pipeline/config already exists — not touching it. Current value:");
  console.log(JSON.stringify(existing.data, null, 2));
  process.exit(0);
}
await setDoc(env, "pipeline/config", STARTER);
console.log("Seeded pipeline/config ✅");
console.log("Next: open the Firebase console and add the rest of your senders:");
console.log("https://console.firebase.google.com/project/japanclan2k6/firestore → pipeline/config → senders");
