import { createElement, type ReactElement } from "react";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  orderCount: vi.fn(),
  orderFindMany: vi.fn(),
  orderAggregate: vi.fn(),
  orderGroupBy: vi.fn(),
  feedbackAggregate: vi.fn(),
  feedbackFindMany: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: prismaMocks.queryRaw,
    order: {
      count: prismaMocks.orderCount,
      findMany: prismaMocks.orderFindMany,
      aggregate: prismaMocks.orderAggregate,
      groupBy: prismaMocks.orderGroupBy,
    },
    feedback: {
      aggregate: prismaMocks.feedbackAggregate,
      findMany: prismaMocks.feedbackFindMany,
    },
  },
}));

vi.mock("@/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth")>();
  return {
    ...actual,
    requireUser: authMocks.requireUser,
    getSessionUser: authMocks.getSessionUser,
  };
});

import { GET as healthGet } from "@/app/api/health/route";
import { GET as ordersGet } from "@/app/api/orders/route";
import { GET as analyticsGet } from "@/app/api/admin/analytics/route";
import { StatusBadge } from "@/components/status-badge";
import { statusLabel } from "@/lib/order-status";
import MyOrdersPage from "@/app/(student)/orders/page";
import NotificationsPage from "@/app/(student)/notifications/page";
import { AdminDashboard } from "@/features/admin/admin-dashboard";
import { AdminOrdersTable } from "@/features/admin/admin-orders-table";
import { AdminPayments } from "@/features/admin/admin-payments";
import { AdminPricing } from "@/features/admin/admin-pricing";
import { PricingSection } from "@/features/landing/pricing-section";
import { ToastProvider } from "@/components/toast";

const ALL_COMMITTED_MIGRATIONS = readdirSync(join(process.cwd(), "prisma", "migrations"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  authMocks.requireUser.mockResolvedValue({
    id: "student-1",
    role: "STUDENT",
    name: "Test Student",
    email: "student@example.test",
  });
  authMocks.getSessionUser.mockResolvedValue({
    id: "admin-1",
    role: "ADMIN",
    name: "Admin User",
    email: "admin@example.test",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /api/health schema readiness gate", () => {
  it("returns 200 ok only when all committed migrations have completed", async () => {
    prismaMocks.queryRaw.mockResolvedValueOnce(
      ALL_COMMITTED_MIGRATIONS.map((migration_name) => ({ migration_name }))
    );

    const res = await healthGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns 503 SCHEMA_OUTDATED without leaking migration names when migrations are pending", async () => {
    // Reproduces the exact live Production state: 3 migrations applied, 2 pending.
    prismaMocks.queryRaw.mockResolvedValueOnce([
      { migration_name: "20261013000000_init" },
      { migration_name: "20261014000000_recovery_codes" },
      { migration_name: "20261015000000_direct_upload_intents" },
    ]);

    const res = await healthGet();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("10");
    const requestId = res.headers.get("x-request-id");
    expect(requestId).toBeTruthy();

    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      error: "Service is updating. Please try again in a moment.",
      code: "SCHEMA_OUTDATED",
      requestId,
    });
    expect(JSON.stringify(body)).not.toContain("20261020");
    expect(JSON.stringify(body)).not.toContain("_prisma_migrations");
  });

  it("returns 503 SCHEMA_OUTDATED when _prisma_migrations does not exist yet", async () => {
    prismaMocks.queryRaw.mockRejectedValueOnce(
      new Error('relation "_prisma_migrations" does not exist')
    );

    const res = await healthGet();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("SCHEMA_OUTDATED");
  });

  it("returns 503 SERVICE_UNAVAILABLE when the database is unreachable", async () => {
    prismaMocks.queryRaw.mockRejectedValueOnce(
      Object.assign(new Error("Can't reach database server"), { code: "P1001" })
    );

    const res = await healthGet();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("API routes preserve legacy statuses and sanitize schema mismatches", () => {
  it.each(["COMPLETED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW", "READY_FOR_COLLECTION", "DELIVERED"])(
    "accepts status filter %s in GET /api/orders and serializes legacy/canonical rows cleanly",
    async (status) => {
      prismaMocks.orderCount.mockResolvedValueOnce(1);
      prismaMocks.orderFindMany.mockResolvedValueOnce([
        {
          id: "11111111-1111-4111-8111-111111111111",
          orderNumber: "XE-2026-000010",
          status,
          paymentStatus: "PAYMENT_CONFIRMED",
          totalAmount: "48.00",
          totalPages: 6,
          copies: 1,
          colorMode: "COLOR",
          paperSize: "A4",
          pageSelection: "ALL",
          createdAt: new Date("2026-10-20T00:00:00Z"),
          updatedAt: new Date("2026-10-20T00:00:00Z"),
          feedback: null,
        },
      ]);

      const res = await ordersGet(
        new Request(`http://localhost:3000/api/orders?page=1&pageSize=10&status=${status}`)
      );
      expect(res.status).toBe(200);
      expect(prismaMocks.orderFindMany.mock.calls.at(-1)?.[0].where).toEqual({
        userId: "student-1",
        status,
      });
      const data = await res.json();
      expect(data.orders[0].status).toBe(status);
      expect(data.orders[0].totalAmount).toBe(48);
    }
  );

  it("returns sanitized 503 SCHEMA_OUTDATED on GET /api/admin/analytics when enum labels are missing", async () => {
    prismaMocks.orderCount.mockRejectedValueOnce(
      new Error('invalid input value for enum "OrderStatus": "ORDER_RECEIVED"')
    );

    const res = await analyticsGet();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("SCHEMA_OUTDATED");
    expect(JSON.stringify(body)).not.toContain("ORDER_RECEIVED");
  });
});

describe("Status badges and UI error/filter states", () => {
  it("renders human-readable StatusBadge markup for DELIVERED and all live legacy statuses", () => {
    const expectedBadges: Array<[string, string]> = [
      ["DELIVERED", "text-emerald-300"],
      ["COMPLETED", "text-emerald-300"],
      ["PAYMENT_PENDING", "text-amber-300"],
      ["PAYMENT_UNDER_REVIEW", "text-amber-300"],
      ["READY_FOR_COLLECTION", "text-emerald-300"],
    ];

    expect(statusLabel("DELIVERED")).toBe("Order Delivered");
    for (const [status, colorClass] of expectedBadges) {
      const html = renderToStaticMarkup(createElement(StatusBadge, { status }));
      expect(html).toContain(statusLabel(status));
      expect(html).toContain(colorClass);
    }
  });

  it("exposes both canonical and legacy status filter options in student and admin order views", () => {
    const studentHtml = renderToStaticMarkup(createElement(MyOrdersPage));
    const adminHtml = renderToStaticMarkup(createElement(AdminOrdersTable));

    for (const status of [
      "ORDER_RECEIVED",
      "ACCEPTED",
      "PRINTING",
      "READY_FOR_PICKUP",
      "DELIVERED",
      "REJECTED",
      "CANCELLED",
      "PAYMENT_PENDING",
      "PAYMENT_UNDER_REVIEW",
      "READY_FOR_COLLECTION",
      "COMPLETED",
    ]) {
      expect(studentHtml).toContain(`value="${status}"`);
      expect(adminHtml).toContain(`value="${status}"`);
    }
  });

  it("renders explicit retryable ErrorState UI across student, admin, and public views on 503 API failures", async () => {
    // Stub global fetch so every client `api(...)` / `fetch(...)` request fails with a 503 SCHEMA_OUTDATED payload.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "Service is updating. Please try again in a moment.",
            code: "SCHEMA_OUTDATED",
            requestId: "req-test-503",
          }),
          { status: 503, headers: { "content-type": "application/json", "Retry-After": "10" } }
        )
      )
    );

    // Execute a component function across state updates triggered by its mount effect.
    async function renderAfterEffects(
      Component: (props: Record<string, unknown>) => ReactElement,
      props: Record<string, unknown> = {}
    ): Promise<string> {
      const React = await import("react");
      const states: unknown[] = [];
      let cursor = 0;
      const effects: Array<() => void | (() => void)> = [];

      const runPass = () => {
        cursor = 0;
        const dispatcher = {
          useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
            const idx = cursor++;
            if (!(idx in states)) {
              states[idx] = typeof initial === "function" ? (initial as () => S)() : initial;
            }
            const setState = (next: S | ((prev: S) => S)) => {
              states[idx] = typeof next === "function" ? (next as (prev: S) => S)(states[idx] as S) : next;
            };
            return [states[idx] as S, setState];
          },
          useCallback<T extends (...args: never[]) => unknown>(fn: T): T {
            return fn;
          },
          useMemo<T>(fn: () => T): T {
            return fn();
          },
          useRef<T>(initial: T): { current: T } {
            return { current: initial };
          },
          useContext<T>(ctx: { _currentValue?: T }): T {
            return ctx._currentValue as T;
          },
          useEffect(effect: () => void | (() => void)) {
            effects.push(effect);
          },
        };
        const internals = (
          React as unknown as {
            __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H: unknown };
          }
        ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
        const prev = internals ? internals.H : undefined;
        if (internals) internals.H = dispatcher;
        try {
          return Component(props);
        } finally {
          if (internals) internals.H = prev;
        }
      };

      vi.useFakeTimers();
      try {
        runPass();
        const cleanups = effects.splice(0).map((fn) => fn());
        await vi.advanceTimersByTimeAsync(300);
        for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
        return renderToStaticMarkup(createElement(ToastProvider, null, runPass()));
      } finally {
        vi.useRealTimers();
      }
    }

    const ordersHtml = await renderAfterEffects(MyOrdersPage as never);
    expect(ordersHtml).toContain("Could not load orders");
    expect(ordersHtml).toContain("Try again");
    expect(ordersHtml).not.toContain("No orders found");

    const notificationsHtml = await renderAfterEffects(NotificationsPage as never);
    expect(notificationsHtml).toContain("Could not load notifications");
    expect(notificationsHtml).toContain("Try again");
    expect(notificationsHtml).not.toContain("all caught up");

    const adminDashHtml = await renderAfterEffects(AdminDashboard as never, { role: "SUPER_ADMIN" });
    expect(adminDashHtml).toContain("Could not load dashboard metrics");
    expect(adminDashHtml).toContain("Try again");

    const adminOrdersHtml = await renderAfterEffects(AdminOrdersTable as never);
    expect(adminOrdersHtml).toContain("Could not load orders");
    expect(adminOrdersHtml).toContain("Try again");
    expect(adminOrdersHtml).not.toContain("No orders match your filters");

    const adminPaymentsHtml = await renderAfterEffects(AdminPayments as never);
    expect(adminPaymentsHtml).toContain("Could not load payments");
    expect(adminPaymentsHtml).toContain("Try again");
    expect(adminPaymentsHtml).not.toContain("No payments waiting for review");

    const adminPricingHtml = await renderAfterEffects(AdminPricing as never, { canEdit: true });
    expect(adminPricingHtml).toContain("Could not load pricing");
    expect(adminPricingHtml).toContain("Try again");

    const publicPricingHtml = await renderAfterEffects(PricingSection as never);
    expect(publicPricingHtml).toContain("Current rates could not be loaded");
    expect(publicPricingHtml).toContain("Try again");
  });
});
