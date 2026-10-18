// Renders the Collection desk page on the server to catch import and render faults, and pins
// its initial state. The interaction (check, then confirm) is covered by the API tests in
// collection-token.test.ts; this file does not run a browser.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/toast", () => ({ useToast: () => () => undefined }));

describe("Admin → Collection page", () => {
  it("renders the code field and a check button that starts disabled", async () => {
    const { AdminCollection } = await import("@/features/admin/admin-collection");
    const html = renderToStaticMarkup(createElement(AdminCollection));
    expect(html).toContain("Collection code");
    expect(html).toContain("Check code");
    const checkButton = html.split("<button").find((chunk) => chunk.includes("Check code")) ?? "";
    expect(checkButton).toContain("disabled");
    // The confirm step is only shown after a successful check.
    expect(html).not.toContain("Confirm collected");
  });

  it("is reachable from the admin navigation", async () => {
    const fs = await import("node:fs");
    const chrome = fs.readFileSync(new URL("../src/features/admin/admin-chrome.tsx", import.meta.url), "utf8");
    expect(chrome).toContain('href: "/admin/collection"');
  });
});
