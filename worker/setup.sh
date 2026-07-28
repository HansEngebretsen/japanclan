#!/usr/bin/env bash
# One-command setup for the japanclan email → calendar worker.
#
# Security note: the service-account key is created by gcloud, streamed
# straight into Cloudflare's encrypted secret store, and never written to your
# disk — no file in ~/Downloads to leak, forget about, or accidentally commit.
#
# Safe to re-run: every step checks first and skips what's already done.
#
#   cd worker && ./setup.sh

set -euo pipefail

PROJECT="${GCP_PROJECT:-japanclan2k6}"
SA_NAME="japanclan-mail"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
WORKER_NAME="japanclan-mail"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  ✅ %s\n" "$1"; }
warn() { printf "  ⚠️  %s\n" "$1"; }
die()  { printf "  ❌ %s\n" "$1" >&2; exit 1; }

cd "$(dirname "$0")"

# ---------------------------------------------------------------- preflight
bold "Checking your tools"
command -v gcloud >/dev/null || die "gcloud not found — install: https://cloud.google.com/sdk/docs/install"
command -v node >/dev/null   || die "node not found — install Node 20+ from nodejs.org"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node 20+ required (you have $(node -v))"
ok "gcloud and node $(node -v)"

ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
if [ -z "$ACCOUNT" ] || [ "$ACCOUNT" = "(unset)" ]; then
  echo "  Opening a browser to sign in to Google Cloud…"
  gcloud auth login
  ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
fi
ok "Google Cloud: $ACCOUNT"
gcloud config set project "$PROJECT" >/dev/null 2>&1
ok "Project: $PROJECT"

[ -d node_modules ] || { echo "  Installing dependencies…"; npm install --silent; }
ok "Dependencies installed"

if ! npx wrangler whoami 2>&1 | grep -qiE "associated with the email|You are logged in"; then
  echo "  Opening a browser to sign in to Cloudflare…"
  npx wrangler login
fi
ok "Cloudflare: signed in"

# ------------------------------------------------------- service account
bold "Service account (least privilege: Firestore only)"
if gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  ok "$SA_NAME already exists"
else
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="japanclan mail worker" \
    --description="Writes parsed booking emails into the trip itinerary" >/dev/null
  ok "Created $SA_EMAIL"
fi

if gcloud projects get-iam-policy "$PROJECT" \
     --flatten="bindings[].members" --format="value(bindings.role)" \
     --filter="bindings.members:${SA_EMAIL}" 2>/dev/null | grep -q "roles/datastore.user"; then
  ok "Already has roles/datastore.user"
else
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/datastore.user" >/dev/null
  ok "Granted roles/datastore.user (Firestore read/write — and nothing else)"
fi

# -------------------------------------------------------------- deploy
# Must come before the secrets: `wrangler secret put` can only target a worker
# that already exists ("This Worker does not exist on your account"), so a fresh
# account has to deploy first. Setting a secret publishes a new version by
# itself, so there's no need to deploy again afterwards.
bold "Deploying the worker"
npx wrangler deploy 2>&1 | grep -vE "^(npm notice|$)" | tail -6
ok "Worker '$WORKER_NAME' deployed"

# ------------------------------------------------------------- secrets
bold "Secrets → Cloudflare (nothing touches your disk)"
EXISTING_SECRETS="$(npx wrangler secret list 2>/dev/null || echo '')"

if echo "$EXISTING_SECRETS" | grep -q "GCP_SA_KEY"; then
  ok "GCP_SA_KEY already set (delete it in the Cloudflare dashboard to rotate)"
else
  echo "  Creating a key and streaming it straight into Cloudflare…"
  # /dev/stdout keeps the private key out of the filesystem entirely.
  gcloud iam service-accounts keys create /dev/stdout --iam-account="$SA_EMAIL" 2>/dev/null \
    | npx wrangler secret put GCP_SA_KEY >/dev/null
  ok "GCP_SA_KEY stored in Cloudflare (never written to disk)"
fi

if echo "$EXISTING_SECRETS" | grep -q "GEMINI_API_KEY"; then
  ok "GEMINI_API_KEY already set"
else
  # Pre-set GEMINI_API_KEY in the environment to run unattended, e.g.
  #   GEMINI_API_KEY="$(some-command-that-prints-it)" ./setup.sh
  # Otherwise the key is prompted for, and never echoed.
  if [ -n "${GEMINI_API_KEY:-}" ]; then
    GEMINI_KEY="$GEMINI_API_KEY"
    echo "  Using GEMINI_API_KEY from the environment."
  else
    echo ""
    echo "  Paste your Gemini API key (from https://aistudio.google.com → Get API key)."
    echo "  It won't be echoed to the screen:"
    read -rs GEMINI_KEY
  fi
  [ -n "$GEMINI_KEY" ] || die "No key entered — re-run ./setup.sh when you have one"
  printf "%s" "$GEMINI_KEY" | npx wrangler secret put GEMINI_API_KEY >/dev/null
  unset GEMINI_KEY
  ok "GEMINI_API_KEY stored in Cloudflare"
fi

# ------------------------------------------------------- seed the config
bold "Seeding Firestore config (uses YOUR gcloud login, no key file)"
node seed-config.mjs

# --------------------------------------------------------- key hygiene
bold "Key hygiene"
KEY_COUNT="$(gcloud iam service-accounts keys list --iam-account="$SA_EMAIL" \
  --managed-by=user --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$KEY_COUNT" -gt 1 ]; then
  warn "$KEY_COUNT user-managed keys exist. Keep only the newest:"
  echo "     gcloud iam service-accounts keys list --iam-account=$SA_EMAIL --managed-by=user"
  echo "     gcloud iam service-accounts keys delete KEY_ID --iam-account=$SA_EMAIL"
else
  ok "Exactly one key exists, and only Cloudflare has it"
fi

bold "Done — one manual step left"
cat <<EOF
  In the Cloudflare dashboard: Email → Email Routing → Routing rules,
  on the trips.haaans.com subdomain, set the catch-all action to
  "Send to a Worker" → $WORKER_NAME

  Then verify everything:   npm run check
  Then send a test email:   forward a booking to japan@trips.haaans.com

  To rotate the key later: delete GCP_SA_KEY in the Cloudflare dashboard,
  delete the old key with gcloud (command above), and re-run ./setup.sh
EOF
