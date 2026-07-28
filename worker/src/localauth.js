/* Credentials for the LOCAL tools (seed/check) only — never used by the Worker.
   Prefers your own gcloud login, so no service-account key file has to exist on
   disk. Falls back to a key file only if you explicitly point at one. */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function localEnv() {
  const project = process.env.GCP_PROJECT || "japanclan2k6";

  // 1. Your own gcloud credentials — short-lived, nothing stored.
  try {
    const token = execSync("gcloud auth print-access-token", {
      stdio: ["ignore", "pipe", "ignore"], timeout: 30000,
    }).toString().trim();
    if (token) return { GCP_ACCESS_TOKEN: token, GCP_PROJECT: project, via: "gcloud" };
  } catch { /* not logged in / not installed — try the fallback */ }

  // 2. Explicit key file (only if you chose to create one).
  const file = process.env.GCP_SA_KEY_FILE;
  if (file) {
    return {
      GCP_SA_KEY: readFileSync(file.replace(/^~/, process.env.HOME || "~"), "utf8"),
      GCP_PROJECT: project,
      via: "key file",
    };
  }

  console.error(
    "No Google credentials available.\n\n" +
    "Easiest fix (no key file needed):\n" +
    "  gcloud auth login\n" +
    "  gcloud config set project japanclan2k6\n\n" +
    "Or, if you already have a service-account key file:\n" +
    "  GCP_SA_KEY_FILE=/path/to/key.json npm run seed"
  );
  process.exit(1);
}
