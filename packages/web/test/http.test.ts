// Not covered: the headers next.config.ts adds to every route, which only a built and running app returns.
import { describe, expect, it } from "vitest";
import { badRequest, json, notFound, serverError } from "@/lib/http";

describe("json", () => {
  it("writes bigint as a decimal string, exactly, past 2^53", async () => {
    const response = json({ amountMinor: BigInt("12345678901234567891"), parts: [BigInt(1), BigInt(-7)], label: "ok" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"amountMinor":"12345678901234567891","parts":["1","-7"],"label":"ok"}');
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  it("uses the status it is given", () => {
    expect(json({}, { status: 201 }).status).toBe(201);
  });
});

describe("notFound", () => {
  it("returns identical bytes and headers on every call", async () => {
    const first = notFound();
    const second = notFound();

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array(await second.arrayBuffer()));
    expect([...first.headers.entries()]).toEqual([...second.headers.entries()]);
    expect(await notFound().text()).toBe('{"error":{"code":"not_found"}}');
  });
});

describe("badRequest", () => {
  it("returns 400 with only the code", async () => {
    const response = badRequest("invalid_body");

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":{"code":"invalid_body"}}');
  });
});

describe("every helper", () => {
  it.each([
    ["json", () => json({ ok: true })],
    ["notFound", notFound],
    ["badRequest", () => badRequest("invalid_body")],
    ["serverError", serverError],
  ])("%s sets Cache-Control: no-store", (_name, make) => {
    expect(make().headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("serverError", () => {
  it("returns 500 with the bare code and nothing else", async () => {
    const response = serverError();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":{"code":"internal"}}');
    expect([...response.headers.keys()].sort()).toEqual(["cache-control", "content-type"]);
  });
});
