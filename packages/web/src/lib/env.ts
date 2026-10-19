import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/**
 * The server's environment, validated on first use.
 * Throws naming the variable, never its value, because the value holds the database password.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse({ DATABASE_URL: process.env.DATABASE_URL });
  if (!parsed.success) {
    throw new Error("env: DATABASE_URL missing or invalid");
  }
  cached = parsed.data;
  return cached;
}
