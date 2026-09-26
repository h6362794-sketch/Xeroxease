/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [],
  },
  poweredByHeader: false,
  reactStrictMode: true,
  // NOTE: The project currently lives on a FAT32 drive (D:) whose filesystem is
  // flagged "dirty / full repair needed". Node's fs.readlink() returns EISDIR for
  // regular files there, which crashes Next.js's output file tracing during build
  // (Error: EISDIR: illegal operation on a directory, readlink '...').
  // Disabling tracing keeps production builds working on this machine.
  // IMPORTANT: run `chkdsk D: /f` and preferably move the project to an NTFS drive;
  // then this workaround can be removed.
  ...(process.env.NEXT_DISABLE_FILE_TRACING === "1"
    ? { experimental: { outputFileTracingExcludes: { "*": ["**"] } } }
    : {}),
};

export default nextConfig;
