// Optional local component check; not a production/Next.js end-to-end test.
// Requires Playwright and a Chromium executable (or @sparticuz/chromium).
// Install test tooling outside this repository; NODE_PATH may point to it.
// Run: node scripts/verify-intro-browser.mjs
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium: playwright } = require("playwright");
const root = process.cwd();
await mkdir(path.join(root, ".data"), { recursive: true });
const fixture = await mkdtemp(path.join(root, ".data", "intro-browser-"));
let server;
let browser;
let passed = 0;
const pass = (name) => { passed++; console.log(`PASS ${name}`); };
try {
  await writeFile(path.join(fixture, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="overflow:auto"><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>');
  await writeFile(path.join(fixture, "main.jsx"), `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { IntroGate } from '/@fs/${root}/src/components/intro-gate.tsx';
    import '/@fs/${root}/src/app/globals.css';
    function App() {
      const [mounted, setMounted] = useState(true);
      window.remountIntro = async () => {
        setMounted(false); await new Promise(r => setTimeout(r, 50)); setMounted(true);
      };
      return mounted ? <IntroGate><button data-underlying>Underlying site</button></IntroGate> : null;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
  `);
  server = await createServer({
    configFile: false, root: fixture, publicDir: path.join(root, "public"),
    css: { postcss: root },
    resolve: { alias: { "@": path.join(root, "src") } },
    oxc: { jsx: { runtime: "automatic" } },
    server: { host: "0.0.0.0", port: 4183, strictPort: true, allowedHosts: true, fs: { allow: [root] } },
  });
  await server.listen();
  let executablePath = process.env.BROWSER_EXECUTABLE;
  let args = [];
  if (!executablePath) {
    const bundled = require("@sparticuz/chromium");
    const chromium = bundled.default ?? bundled;
    executablePath = await chromium.executablePath();
    args = chromium.args.filter(x => !["--single-process", "--disable-web-security", "--allow-running-insecure-content"].includes(x));
  }
  browser = await playwright.launch({ executablePath, args, headless: true });
  const url = "http://127.0.0.1:4183";
  const viewports = [
    // Mobile portrait & landscape
    [320, 568], [568, 320],
    [360, 800], [800, 360],
    [375, 812], [812, 375],
    [390, 844], [844, 390],
    [430, 932], [932, 430],
    // Tablet portrait & landscape
    [768, 1024], [1024, 768],
    // Desktop / laptop
    [1280, 720],
    [1366, 768],
    [1440, 900],
    [1920, 1080],
  ];
  for (const [width, height] of viewports) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(url);
    await page.locator("video").waitFor();
    const box = await page.locator("video").boundingBox();
    const ratio = 16 / 9;
    assert(Math.abs(box.width / box.height - ratio) < 0.01, `expected 16:9 at ${width}x${height}, got ${box.width}x${box.height}`);
    if (width / height <= ratio) {
      assert(Math.abs(box.width - width) <= 1, `expected full width ${width} at ${width}x${height}, got ${box.width}`);
    }
    if (width / height >= ratio) {
      assert(Math.abs(box.height - height) <= 1, `expected full height ${height} at ${width}x${height}, got ${box.height}`);
    }
    assert(Math.abs((box.x + box.width / 2) - width / 2) <= 1, `expected horizontal center at ${width}x${height}`);
    assert(Math.abs((box.y + box.height / 2) - height / 2) <= 1, `expected vertical center at ${width}x${height}`);
    assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1);
    assert.equal(await page.locator("video").evaluate(v => getComputedStyle(v).objectFit), "contain");
    const skipBox = await page.getByRole("button", { name: "Skip introduction" }).boundingBox();
    assert(skipBox.x >= 0 && skipBox.y >= 0 && skipBox.x + skipBox.width <= width && skipBox.y + skipBox.height <= height);
    assert.equal(await page.getByRole("button", { name: "Skip introduction" }).evaluate(v => v === document.activeElement), true);
    for (const key of ["Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      assert.equal(await page.getByRole("button", { name: "Skip introduction" }).evaluate(v => v === document.activeElement), true);
    }
    assert.equal(await page.locator("[data-underlying]").evaluate(v => !!v.closest("[inert]")), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    pass(`viewport ${width}x${height} (${ box.width.toFixed(1) }x${ box.height.toFixed(1) }), contain, focus loop, inert background, no overflow/errors`);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.05);
  assert.deepEqual(await page.locator("video").evaluate(v => [v.videoWidth, v.videoHeight, v.muted, v.playsInline]), [1280,720,true,true]);
  pass("actual asset decodes and advances playback inline/muted");
  await page.locator("video").evaluate(v => { window.originalVideo = v; window.playhead = v.currentTime; });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("video").evaluate(v => v === window.originalVideo && v.currentTime >= window.playhead), true);
  const rotated = await page.locator("video").boundingBox();
  assert(Math.abs(rotated.width / rotated.height - 16/9) < 0.01);
  assert(Math.abs(rotated.height - 390) <= 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const restored = await page.locator("video").boundingBox();
  assert(Math.abs(restored.width / restored.height - 16/9) < 0.01);
  assert(Math.abs(restored.width - 390) <= 1);
  pass("rotation preserves element/playhead and resizes smoothly across portrait and landscape");
  await page.getByRole("button", { name: "Skip introduction" }).click();
  assert.equal(await page.locator("[data-underlying]").evaluate(v => !!v.closest("[inert]")), true);
  assert.equal(await page.evaluate(() => window.originalVideo.paused), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.getByRole("button", { name: "Skip introduction" }).evaluate(v => v === document.activeElement), true);
  await page.locator('[role="dialog"]').waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-underlying]").evaluate(v => !!v.closest("[inert]")), false);
  assert.equal(await page.evaluate(() => document.body.style.overflow), "auto");
  pass("Skip pauses playback and retains isolation until exit; restores overflow");
  await page.reload(); await page.locator("[data-underlying]").waitFor();
  assert.equal(await page.locator("video").count(), 0);
  pass("session dismissal survives reload");
  await page.evaluate(() => sessionStorage.clear()); await page.reload(); await page.locator("video").waitFor();
  await page.keyboard.press("Escape"); await page.locator('[role="dialog"]').waitFor({ state: "detached" });
  pass("Escape dismisses");
  await page.evaluate(() => sessionStorage.clear()); await page.emulateMedia({ reducedMotion: "reduce" }); await page.reload();
  await page.locator("[data-underlying]").waitFor(); assert.equal(await page.locator("video").count(), 0);
  pass("initial reduced motion bypasses intro");
  await page.emulateMedia({ reducedMotion: "no-preference" }); await page.reload(); await page.locator("video").waitFor();
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.locator('[role="dialog"]').waitFor({ state: "detached" });
  pass("live reduced-motion change dismisses");
  await page.evaluate(() => sessionStorage.clear()); await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/brand/xeroxease-intro.mp4", route => route.abort()); await page.reload();
  await page.getByRole("button", { name: "Enter site" }).waitFor();
  await page.getByRole("button", { name: "Enter site" }).click(); await page.locator('[role="dialog"]').waitFor({ state: "detached" });
  pass("video network failure provides actionable fallback");
  const blocked = await browser.newContext();
  await blocked.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  const blockedPage = await blocked.newPage(); await blockedPage.goto(url); await blockedPage.locator("video").waitFor();
  await blockedPage.keyboard.press("Escape"); await blockedPage.locator('[role="dialog"]').waitFor({ state: "detached" });
  await blockedPage.evaluate(() => window.remountIntro()); await blockedPage.locator("[data-underlying]").waitFor();
  assert.equal(await blockedPage.locator("video").count(), 0);
  pass("storage denial still remembers dismissal across component remount");
  console.log(`${passed} browser scenarios passed, 0 failed`);
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixture, { recursive: true, force: true });
}
