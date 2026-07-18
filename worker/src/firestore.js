/* Minimal Firestore REST client: get + committed writes with preconditions,
   plus the typed-value codec. Security rules don't apply to these requests
   (IAM does), so the itinerary doc stays client-locked. */

import { getBearer, saInfo } from "./gauth.js";

function root(env) {
  return env.FIRESTORE_HOST || "https://firestore.googleapis.com";
}
function docsBase(env) {
  return `${root(env)}/v1/projects/${saInfo(env).project_id}/databases/(default)/documents`;
}
function docName(env, path) {
  return `projects/${saInfo(env).project_id}/databases/(default)/documents/${path}`;
}

async function call(env, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getBearer(env)}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Firestore ${method} ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.code = /ALREADY_EXISTS/.test(text) ? "ALREADY_EXISTS"
      : /FAILED_PRECONDITION/.test(text) ? "FAILED_PRECONDITION" : undefined;
    throw err;
  }
  return res.json();
}

/* ---- typed-value codec ---- */
export function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: encFields(v) } };
}
export function encFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = enc(v);
  return out;
}
export function dec(value) {
  if (!value || "nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(dec);
  if ("mapValue" in value) return decFields(value.mapValue.fields || {});
  return null;
}
export function decFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = dec(v);
  return out;
}

/* ---- operations ---- */
export async function getDoc(env, path) {
  try {
    const doc = await call(env, "GET", `${docsBase(env)}/${path}`);
    return { data: decFields(doc.fields), updateTime: doc.updateTime };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/* Full-document set. Options:
   - updateTime: optimistic-concurrency precondition (throws FAILED_PRECONDITION on mismatch)
   - mustNotExist: create-only (throws ALREADY_EXISTS if present) — used for dedup markers
   Returns the committed document's new updateTime (needed for safe undo). */
export async function setDoc(env, path, data, { updateTime, mustNotExist } = {}) {
  const write = { update: { name: docName(env, path), fields: encFields(data) } };
  if (updateTime) write.currentDocument = { updateTime };
  else if (mustNotExist) write.currentDocument = { exists: false };
  const res = await call(env, "POST", `${docsBase(env)}:commit`, { writes: [write] });
  return res.writeResults?.[0]?.updateTime || res.commitTime;
}

export async function deleteDoc(env, path) {
  await call(env, "POST", `${docsBase(env)}:commit`, { writes: [{ delete: docName(env, path) }] });
}

/* Latest docs from a subcollection, newest first by `ts`. No `where` clause on
   purpose: equality-filter + orderBy would demand a composite index, which is a
   setup landmine — collections here are tiny, so callers filter in JS. */
export async function latestDocs(env, parentPath, collectionId, limit = 10) {
  const res = await call(env, "POST", `${docsBase(env)}/${parentPath}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId }],
      orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }],
      limit,
    },
  });
  return (Array.isArray(res) ? res : [])
    .filter((r) => r.document)
    .map((r) => ({
      path: r.document.name.replace(/^.*\/documents\//, ""),
      data: decFields(r.document.fields),
    }));
}
