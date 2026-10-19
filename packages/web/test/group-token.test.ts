// Not covered: randomness quality beyond 1,000 distinct samples, and how the token travels between browser and server.
import { describe, expect, it } from "vitest";
import { hashGroupToken, mintGroupToken, parseGroupToken } from "@/lib/group-token";

const URL_SAFE_22 = /^[A-Za-z0-9_-]{22}$/;

describe("mintGroupToken", () => {
  it("returns 22 characters of the url-safe alphabet", () => {
    for (let i = 0; i < 200; i++) {
      expect(mintGroupToken().token).toMatch(URL_SAFE_22);
    }
  });

  it("never repeats across 1,000 tokens", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => mintGroupToken().token));
    expect(tokens.size).toBe(1000);
  });

  it("returns the hash of the token it returns", () => {
    const { token, hash } = mintGroupToken();
    expect(hash).toBe(hashGroupToken(token));
    expect(hash).not.toContain(token);
  });
});

describe("hashGroupToken", () => {
  it("is 64 lowercase hex and the same on every call", () => {
    const { token } = mintGroupToken();
    const hash = hashGroupToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGroupToken(token)).toBe(hash);
  });

  it("matches sha256 computed outside Node", () => {
    // From: printf '%s' 'AAAAAAAAAAAAAAAAAAAAAA' | sha256sum
    expect(hashGroupToken("AAAAAAAAAAAAAAAAAAAAAA")).toBe(
      "8a5bdb4cc15164126c6ef2668de9dd240d299ce6397a42c95a9411b93d080ed8",
    );
  });
});

describe("parseGroupToken", () => {
  const good = mintGroupToken().token;

  it("accepts a minted token unchanged", () => {
    expect(parseGroupToken(good)).toBe(good);
  });

  it("rejects 21 and 23 characters", () => {
    expect(parseGroupToken(good.slice(0, 21))).toBeNull();
    expect(parseGroupToken(`${good}A`)).toBeNull();
  });

  it.each(["+", "/", "="])("rejects %s from standard base64", (char) => {
    expect(parseGroupToken(`${good.slice(0, 21)}${char}`)).toBeNull();
  });

  it.each([
    ["a leading space", ` ${good.slice(1)}`],
    ["a trailing space", `${good.slice(1)} `],
    ["a trailing newline", `${good.slice(1)}\n`],
    ["a tab inside", `${good.slice(0, 10)}\t${good.slice(11)}`],
    ["the token plus a trailing newline", `${good}\n`],
  ])("rejects %s", (_label, raw) => {
    expect(parseGroupToken(raw)).toBeNull();
  });

  it("rejects null, undefined and the empty string", () => {
    expect(parseGroupToken(null)).toBeNull();
    expect(parseGroupToken(undefined)).toBeNull();
    expect(parseGroupToken("")).toBeNull();
  });
});
