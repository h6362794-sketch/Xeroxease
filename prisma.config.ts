import dotenv from "dotenv";

// The Prisma CLI does not read `.env.local`, while the app (Next.js) and
// `npm run config:check` prefer it. Load the operator-maintained files here so
// `prisma migrate` / `prisma db seed` see the same values: `.env.local` first,
// then `.env`. `dotenv` never overrides an already-set variable, so the real
// environment (CI, Vercel) always wins, and a missing file is silently ignored.
// Values are never logged.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    // Replaces the deprecated `package.json#prisma` seed key (removed below).
    seed: "tsx prisma/seed.ts",
  },
});
