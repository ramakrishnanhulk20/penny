// Not covered: the group page rendering its not-found state (that needs a browser; only the function its load waits on
// is run here), a real browser's AbortSignal, and the 10 s timeout firing (only that the caller's abort reaches fetch).
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPendingReset } from "@/app/g/group-screen";
import type { GroupView } from "@/lib/api-types";

const GROUP_ID = "00000000-0000-4000-8000-000000000001";
const KEPT = "AAAAAAAAAAAAAAAAAAAAAA";

// Session storage holding one kept reset link, as makeNewLink leaves it.
function storageWith(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

function answering(status: number, body: unknown) {
  const signals: AbortSignal[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, signals };
}

const anyMerge = Object.getOwnPropertyDescriptor(AbortSignal, "any");

afterEach(() => {
  if (anyMerge !== undefined) Object.defineProperty(AbortSignal, "any", anyMerge);
  vi.unstubAllGlobals();
});

describe("trying the links this tab kept", () => {
  it("answers null, never throws, when the browser has no AbortSignal.any and the kept link opens nothing", async () => {
    Reflect.deleteProperty(AbortSignal, "any");
    expect("any" in AbortSignal).toBe(false);
    vi.stubGlobal("window", { sessionStorage: storageWith({ [`penny:pending-reset:${GROUP_ID}`]: KEPT }) });
    const server = answering(404, { error: { code: "not_found" } });
    vi.stubGlobal("fetch", server.fetchImpl);

    await expect(openPendingReset(new AbortController().signal)).resolves.toBeNull();
    expect(server.signals).toHaveLength(1);
  });

  it("opens the kept link's group, and passes the caller's abort on to the request", async () => {
    vi.stubGlobal("window", { sessionStorage: storageWith({ [`penny:pending-reset:${GROUP_ID}`]: KEPT }) });
    const group = { id: GROUP_ID, name: "Lisbon trip" } as GroupView;
    const server = answering(200, group);
    vi.stubGlobal("fetch", server.fetchImpl);
    const caller = new AbortController();

    expect(await openPendingReset(caller.signal)).toEqual({ groupId: GROUP_ID, token: KEPT, group });
    expect(server.signals[0].aborted).toBe(false);
    caller.abort();
    expect(server.signals[0].aborted).toBe(true);
  });
});
