import { describe, it, expect, afterEach } from "vitest";
import { formatDateLong, formatDateTimeLong } from "@/lib/utils";

/**
 * SSR hydration determinism for dates.
 *
 * Regression guard. `RecoveryCodePanel` is a client component, but Next.js still
 * renders it on the server, and it renders `initial.createdAt` / `expiresAt` /
 * `usedAt` on that very first pass. Those were formatted with
 * `toLocaleDateString(undefined, …)`, which resolves BOTH the locale and the
 * time zone from the runtime: a Node server in UTC and a browser in IST produce
 * different strings for the same instant — and for a timestamp near midnight
 * they disagree on the *day* (2026-10-14T20:00:00Z is "October 14" in UTC but
 * "October 15" in Asia/Kolkata).
 *
 * That is a hydration mismatch. React 19 answers one by re-rendering the client
 * tree rather than patching the text node, so the cost of the bug went up with
 * the upgrade. `formatDateLong` / `formatDateTimeLong` pin locale and time zone
 * so both sides agree byte for byte.
 */

const originalTz = process.env.TZ;

afterEach(() => {
  // Restore so this file cannot leak a TZ into any other test file.
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/**
 * An instant that straddles midnight in IST: 2026-10-14T20:00:00Z is
 * 2026-10-15 01:30 IST, but still 2026-10-14 in UTC and in the Americas.
 */
const BOUNDARY = "2026-10-14T20:00:00Z";

const ZONES = ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Kiritimati"];

describe("formatDateLong / formatDateTimeLong are SSR-safe", () => {
  it("produces identical output regardless of the runtime time zone", () => {
    const seen = ZONES.map((tz) => {
      process.env.TZ = tz;
      return formatDateLong(BOUNDARY);
    });
    expect(new Set(seen).size, `zone-dependent output: ${JSON.stringify(seen)}`).toBe(1);
  });

  it("is immune to the runtime time zone for the date-time variant too", () => {
    const seen = ZONES.map((tz) => {
      process.env.TZ = tz;
      return formatDateTimeLong(BOUNDARY);
    });
    expect(new Set(seen).size, `zone-dependent output: ${JSON.stringify(seen)}`).toBe(1);
  });

  it("pins to Asia/Kolkata, matching the app's en-IN formatting", () => {
    process.env.TZ = "UTC";
    // The instant is the 15th in IST, not the 14th.
    expect(formatDateLong(BOUNDARY)).toBe("15 October 2026");
  });

  it("would have failed before the fix — the unpinned form is zone-dependent", () => {
    // Documents the actual defect rather than only asserting the cure. If this
    // ever starts passing, Node has stopped honouring TZ at runtime and the
    // tests above have become vacuous.
    function unpinned(tz: string): string {
      process.env.TZ = tz;
      return new Date(BOUNDARY).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    }
    expect(unpinned("UTC")).not.toBe(unpinned("Asia/Kolkata"));
  });

  it("handles null/undefined without throwing", () => {
    expect(formatDateLong(null)).toBe("—");
    expect(formatDateLong(undefined)).toBe("—");
    expect(formatDateTimeLong(null)).toBe("—");
  });

  it("accepts both an ISO string and a Date", () => {
    process.env.TZ = "America/New_York";
    expect(formatDateLong(new Date(BOUNDARY))).toBe(formatDateLong(BOUNDARY));
  });
});
