import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleFetch } from "../src/http.js";
import { verifyIdToken, AuthError } from "../src/auth.js";

vi.mock("../src/auth.js", async (orig) => {
  const actual = await orig();
  return { ...actual, verifyIdToken: vi.fn() };
});
vi.mock("../src/gauth.js", () => ({ saInfo: () => ({ project_id: "japanclan2k6" }) }));

const post = (body, origin = "https://haaans.com") =>
  new Request("https://w.dev/add", {
    method: "POST",
    headers: origin ? { Origin: origin, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => { verifyIdToken.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("HTTP add endpoint — the gate", () => {
  it("rejects an unverifiable token before doing any work", async () => {
    verifyIdToken.mockRejectedValue(new AuthError("bad signature"));
    const res = await handleFetch(post({ idToken: "nope", text: "dinner July 20 7pm" }), {});
    expect(res.status).toBe(401);
    expect((await res.json()).ok).toBe(false);
  });

  it("refuses origins that aren't the app", async () => {
    for (const origin of ["https://evil.example", "http://haaans.com", "https://haaans.com.evil.co"]) {
      const res = await handleFetch(post({ idToken: "t", text: "x" }, origin), {});
      expect(res.status, origin).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin"), origin).toBeNull();
    }
  });

  it("allows the app's own origins", async () => {
    for (const origin of ["https://haaans.com", "http://localhost:4321", "http://127.0.0.1:3000"]) {
      const res = await handleFetch(
        new Request("https://w.dev/add", { method: "OPTIONS", headers: { Origin: origin } }), {});
      expect(res.status, origin).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin"), origin).toBe(origin);
    }
  });

  it("serves only POST /add", async () => {
    const get = new Request("https://w.dev/add", { method: "GET", headers: { Origin: "https://haaans.com" } });
    expect((await handleFetch(get, {})).status).toBe(404);
    const other = new Request("https://w.dev/anything", {
      method: "POST", headers: { Origin: "https://haaans.com" }, body: "{}",
    });
    expect((await handleFetch(other, {})).status).toBe(404);
  });

  it("bounds the input before it ever reaches the model", async () => {
    const empty = await handleFetch(post({ idToken: "t", text: "   " }), {});
    expect(empty.status).toBe(400);
    const huge = await handleFetch(post({ idToken: "t", text: "x".repeat(2001) }), {});
    expect(huge.status).toBe(400);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});

describe("token verification", () => {
  it("rejects structurally invalid tokens without network access", async () => {
    const actual = await vi.importActual("../src/auth.js");
    for (const bad of [undefined, "", "abc", "a.b", "x".repeat(5000)]) {
      await expect(actual.verifyIdToken(bad, "japanclan2k6")).rejects.toBeInstanceOf(actual.AuthError);
    }
  });
});
