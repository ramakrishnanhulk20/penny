import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// Vercel stops this function after 10 s, so no request can hold it open (threat model C26).
export const maxDuration = 10;

// Like /api/health this route has no rate limit: it reads only the docs index built from content/docs and never
// reaches the database or any stored group data.
export const { GET } = createFromSource(source);
