/* Firestore REST auth from a Worker (no Admin SDK here).
   Google APIs accept a self-signed service-account RS256 JWT — with the API
   root as audience — directly as a Bearer token, so no OAuth token-exchange
   round trip is needed. Cached in-isolate until shortly before expiry. */

let cache = { jwt: null, exp: 0 };

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export function saInfo(env) {
  // Emulator mode (wrangler dev with FIRESTORE_HOST set) needs no real key.
  if (env.FIRESTORE_HOST) return { project_id: env.GCP_PROJECT || "japanclan2k6" };
  return JSON.parse(env.GCP_SA_KEY);
}

export async function getBearer(env) {
  if (env.FIRESTORE_HOST) return "owner"; // Firestore emulator accepts anything
  const now = Math.floor(Date.now() / 1000);
  if (cache.jwt && now < cache.exp - 300) return cache.jwt;
  const sa = saInfo(env);
  const exp = now + 3600;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: sa.private_key_id }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://firestore.googleapis.com/",
    iat: now,
    exp,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  cache = { jwt: `${header}.${claims}.${b64url(sig)}`, exp };
  return cache.jwt;
}
