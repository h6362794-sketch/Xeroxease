// Responsive intro video — regression guard.
//
// The original overlay used `object-cover` with a fixed desktop height, which
// cropped the composition on phones and pushed the Skip button off-screen. The
// fix is `object-contain` inside a full-viewport flex column. Asset checks also
// make sure the committed video/poster stay usable (present, non-empty, small).

import { readFileSync, statSync } from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const root = process.cwd();
const source = readFileSync(path.join(root, "src/components/intro-gate.tsx"), "utf8");
// Ignore comments (the file explains the old `object-cover` bug in prose).
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
const page = readFileSync(path.join(root, "src/app/page.tsx"), "utf8");

describe("intro gate fit", () => {
  it("uses object-contain so the whole video is visible without cropping", () => {
    expect(source).toContain("object-contain");
    expect(code).not.toContain("object-cover");
  });

  it("never uses a fixed desktop-only height", () => {
    // Tailwind fixed heights such as h-screen/h-[600px] would overflow short
    // landscape phones; the overlay is sized by `fixed inset-0` + flex instead.
    expect(source).not.toMatch(/\bh-screen\b/);
    expect(source).not.toMatch(/\bh-\[\d+px\]/);
  });

  it("plays inline, muted and with a poster for mobile autoplay policies", () => {
    expect(source).toContain("playsInline");
    expect(source).toContain("muted");
    expect(source).toContain("autoPlay");
    expect(source).toContain('poster="/brand/xeroxease-logo.jpeg"');
    expect(source).toContain('src="/brand/xeroxease-intro.mp4"');
  });

  it("respects reduced-motion and offers keyboard/touch dismissal", () => {
    expect(source).toMatch(/prefers-reduced-motion/);
    expect(source).toContain('"Escape"');
    expect(source).toContain("Skip Intro");
    expect(source).toMatch(/aria-label=/);
    expect(source).toContain("onError");
  });

  it("keeps the overlay mounted once on the landing page", () => {
    expect(page).toContain("<IntroGate>");
    expect(page.match(/<IntroGate>/g)).toHaveLength(1);
  });
});

describe("intro assets", () => {
  for (const [relative, maxBytes] of [
    ["public/brand/xeroxease-intro.mp4", 8 * 1024 * 1024],
    ["public/brand/xeroxease-logo.jpeg", 2 * 1024 * 1024],
  ] as const) {
    it(`ships ${relative} as a non-empty, reasonably sized asset`, () => {
      const stats = statSync(path.join(root, relative));
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.size).toBeLessThan(maxBytes);
    });
  }
});

describe("orientation-aware presentation", () => {
  const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  it("fits both ratios against the available stage with dynamic viewport sizing", () => {
    expect(css).toContain("height: 100dvh");
    expect(css).toContain("container-type: size");
    expect(css).toContain("aspect-ratio: 16 / 9");
    expect(css).toContain("(max-width: 767px) and (orientation: portrait)");
    expect(css).toContain("aspect-ratio: 9 / 16");
    expect(css).toContain("calc(100cqh * 9 / 16)");
  });
  it("retains one video across CSS orientation changes and isolates modal focus", () => {
    expect(code.match(/<video\b/g)).toHaveLength(1);
    expect(code).toContain("inert={introPresent || undefined}");
    expect(code).toContain('e.key === "Tab"');
    expect(code).toContain('reduced.addEventListener("change"');
    expect(code).toContain("videoRef.current?.pause()");
  });
  it("uses the existing 1280x720 landscape track without cropping or generating new imagery", () => {
    const video = readFileSync(path.join(root, "public/brand/xeroxease-intro.mp4"));
    const tkhd = video.indexOf(Buffer.from("tkhd"));
    expect(tkhd).toBeGreaterThan(4);
    const end = tkhd - 4 + video.readUInt32BE(tkhd - 4);
    expect(video.readUInt32BE(end - 8) / 65536).toBe(1280);
    expect(video.readUInt32BE(end - 4) / 65536).toBe(720);
  });
});
