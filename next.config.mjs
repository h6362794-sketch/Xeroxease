/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [],
  },
  poweredByHeader: false,
  reactStrictMode: true,
  // Historical note: the project once ran from a FAT32 volume whose dirty
  // filesystem made Node's fs.readlink() return EISDIR for regular files, which
  // crashed Next.js output-file tracing during `next build`. The workaround used
  // then was a `fs-eisdir-shim.cjs` preload that the scripts referenced -- but the
  // shim was never committed and was listed in .gitignore, so `npm run dev` and
  // `npm run build` failed outright on a clean checkout.
  //
  // The build no longer depends on any shim. If output-file tracing ever needs to
  // be disabled again, set NEXT_DISABLE_FILE_TRACING=1 (see below) instead of
  // introducing an untracked preload file.
  ...(process.env.NEXT_DISABLE_FILE_TRACING === "1"
    ? { experimental: { outputFileTracingExcludes: { "*": ["**"] } } }
    : {}),
};

export default nextConfig;
