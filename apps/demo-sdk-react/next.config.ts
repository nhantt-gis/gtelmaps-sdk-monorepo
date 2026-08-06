import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Without this, Next.js walks up looking for a lockfile and can land outside the
// monorepo (e.g. a stray ~/package-lock.json), which breaks resolution of the
// pnpm-linked `@gis/*` workspace packages.
const monorepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const nextConfig: NextConfig = {
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
