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
