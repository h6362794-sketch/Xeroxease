// The /dashboard boundary must be safe to render, must never leak server detail, and
// must never retry on its own.
//
// Rendering is done with `renderToStaticMarkup` so the component's real output is
// asserted. `useEffect` does not run during a static render, which is also the property
// under test: rendering the boundary must not itself perform work that can fail.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DashboardError from "@/app/(student)/dashboard/error";

function render(error: Error & { digest?: string }) {
  const reset = vi.fn();
  const html = renderToStaticMarkup(createElement(DashboardError, { error, reset }));
  return { html, reset };
}

describe("dashboard error boundary", () => {
  it("renders a recoverable, non-technical message", () => {
    const { html } = render(Object.assign(new Error("boom"), { digest: "3932642283" }));

    expect(html).toContain("load your dashboard");
    expect(html).toContain("Try again");
    // The user is told the problem is ours, not their account.
    expect(html).toContain("Your account is fine");
  });

  it("shows the numeric digest as a support reference", () => {
    const { html } = render(Object.assign(new Error("boom"), { digest: "3932642283" }));
    expect(html).toContain("3932642283");
    expect(html).toContain("Reference:");
  });

  it("omits the reference when the digest is absent or not numeric", () => {
    for (const digest of [undefined, "", "not-a-digest", "<script>alert(1)</script>", "1".repeat(40)]) {
      const { html } = render(Object.assign(new Error("boom"), { digest }));
      expect(html).not.toContain("Reference:");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("not-a-digest");
      expect(html).not.toContain("1".repeat(40));
    }
  });

  it("never renders the server message or stack into the browser", () => {
    const error = Object.assign(
      new Error(
        'The column `orders.pricing_snapshot` does not exist. password=hunter2 postgresql://u:p@db.internal:5432/postgres'
      ),
      { digest: "3932642283" }
    );
    error.stack =
      "Error: The column `orders.pricing_snapshot` does not exist.\n    at /var/task/.next/server/app/dashboard/page.js:1:1";

    const { html } = render(error);

    for (const secret of [
      "pricing_snapshot",
      "hunter2",
      "postgresql://",
      "db.internal",
      "5432",
      "/var/task",
      "at /var",
      "P2022",
    ]) {
      expect(html).not.toContain(secret);
    }
  });

  it("does not call reset while rendering — recovery stays a deliberate action", () => {
    const { reset } = render(Object.assign(new Error("persistent failure"), { digest: "1" }));
    expect(reset).not.toHaveBeenCalled();
  });

  it("renders identically for a persistent failure, so a retry cannot loop", () => {
    // A broken schema does not repair itself between renders; the boundary must be a
    // pure function of the error or repeated attempts would escalate.
    const error = Object.assign(new Error("persistent failure"), { digest: "3932642283" });
    const first = render(error).html;
    const second = render(error).html;
    expect(second).toBe(first);
  });
});
