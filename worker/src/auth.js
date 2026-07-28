/* Firebase ID token verification for the HTTP endpoint.

   This is the security boundary for the whole `fetch` surface: past it, the
   worker writes Firestore with a service-account JWT, which bypasses
   firestore.rules by design. So everything here fails closed.

   Google publishes the signing keys in JWK form, which WebCrypto imports
   directly — the x509 endpoint would need DER parsing to reach the same place.
   Keys rotate roughly daily and the response carries a max-age, which is
   honored rather than guessed at. */

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW_S = 60;

let jwks = { keys: null, exp: 0 };

async function signingKeys() {
  if (jwks.keys && Date.now() < jwks.exp) return jwks.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new AuthError(`couldn't fetch signing keys (${res.status})`);
  const body = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") || "");
  const ttl = maxAge ? Number(maxAge[1]) * 1000 : 3600_000;
  jwks = { keys: body.keys || [], exp: Date.now() + ttl };
  return jwks.keys;
}

export class AuthError extends Error {}

function b64url(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonPart(s) {
  return JSON.parse(new TextDecoder().decode(b64url(s)));
}

/* Returns { email, uid } for a valid token, throws AuthError otherwise. */
export async function verifyIdToken(idToken, projectId) {
  if (typeof idToken !== "string" || idToken.length > 4096) throw new AuthError("missing token");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AuthError("malformed token");

  let header, payload;
  try {
    header = jsonPart(parts[0]);
    payload = jsonPart(parts[1]);
  } catch { throw new AuthError("malformed token"); }

  if (header.alg !== "RS256") throw new AuthError("unexpected algorithm");
  const jwk = (await signingKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError("unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key,
    b64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new AuthError("bad signature");

  // Claims are only trustworthy after the signature check above.
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new AuthError("wrong audience");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new AuthError("wrong issuer");
  if (!payload.exp || payload.exp + CLOCK_SKEW_S < now) throw new AuthError("token expired");
  if (payload.iat && payload.iat - CLOCK_SKEW_S > now) throw new AuthError("token not yet valid");
  if (!payload.sub) throw new AuthError("no subject");
  if (payload.email_verified !== true) throw new AuthError("email not verified");
  const email = String(payload.email || "").toLowerCase();
  if (!email) throw new AuthError("no email");

  return { email, uid: payload.sub };
}
