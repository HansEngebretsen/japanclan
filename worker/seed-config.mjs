/* One-time seeder for the pipeline/config doc — run from worker/:
     GCP_SA_KEY_FILE=~/Downloads/japanclan2k6-xxxx.json npm run seed
   Refuses to overwrite an existing config. Node 20+. */

import { readFileSync } from "node:fs";
import { getDoc, setDoc } from "./src/firestore.js";

const file = process.env.GCP_SA_KEY_FILE;
if (!file) {
  console.error("Set GCP_SA_KEY_FILE to the path of your service-account JSON key.\n" +
    "Example: GCP_SA_KEY_FILE=~/Downloads/japanclan2k6-a1b2c3.json npm run seed");
  process.exit(1);
}
const env = { GCP_SA_KEY: readFileSync(file.replace(/^~/, process.env.HOME || "~"), "utf8") };

const STARTER = {
  senders: {
    "engebretsenh@gmail.com": { name: "Hans", trip: "japan-2026" },
  },
  addresses: {
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
    model: "gemini-2.5-flash",
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
