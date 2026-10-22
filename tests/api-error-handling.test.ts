import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorState } from "@/components/ui";
import { withErrorHandling } from "@/server/api-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API schema-skew error handling (withErrorHandling)", () => {
  it.each([
    [
      "P2022 missing column",
      Object.assign(
        new Error(
          "The column `orders.pricing_snapshot` does not exist in the current database. postgresql://postgres:secretpw@db.internal:5432/postgres"
        ),
        { code: "P2022" }
      ),
      { kind: "missing-column", prismaCode: "P2022", pgCode: "42703", object: "orders.pricing_snapshot" },
    ],
    [
      "22P02 missing OrderStatus enum value",
      new Error(
        'Invalid `prisma.order.count()` invocation: Raw query failed. Code: `22P02`. Message: `invalid input value for enum "OrderStatus": "ORDER_RECEIVED"` params: secret-token'
      ),
      { kind: "missing-enum-value", pgCode: "22P02", object: "OrderStatus.ORDER_RECEIVED" },
    ],
    [
      "missing PaymentMethod enum type",
      new Error('type "PaymentMethod" does not exist'),
      { kind: "missing-enum-type", pgCode: "3F000", object: "PaymentMethod" },
    ],
  ])("maps %s to 503 SCHEMA_OUTDATED without leaking internals or logging raw messages", async (_name, thrown, expectedSkew) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await withErrorHandling(async () => {
      throw thrown;
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("10");
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();

    const body = await response.json();
    expect(body).toEqual({
      error: "Service is updating. Please try again in a moment.",
      code: "SCHEMA_OUTDATED",
      requestId,
    });

    const rawResponse = JSON.stringify(body);
    for (const sensitive of ["pricing_snapshot", "ORDER_RECEIVED", "PaymentMethod", "secretpw", "secret-token", "postgresql://"]) {
      expect(rawResponse).not.toContain(sensitive);
    }

    expect(spy).toHaveBeenCalledTimes(1);
    const [prefix, payload, extra] = spy.mock.calls[0];
    expect(prefix).toBe("[api][schema-skew]");
    expect(extra).toBeUndefined();
    expect(payload).toEqual({
      requestId,
      schemaSkew: expectedSkew,
    });
    expect(JSON.stringify(payload)).not.toMatch(/secretpw|secret-token|postgresql:\/\//);
  });
});

describe("UI ErrorState component", () => {
  it("renders a recoverable error state instead of fake empty order state", () => {
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ErrorState, {
        title: "Could not load orders",
        sub: "Service is updating. Please try again in a moment.",
        onRetry,
      })
    );
    expect(html).toContain("Could not load orders");
    expect(html).toContain("Service is updating. Please try again in a moment.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No orders found");
    expect(onRetry).not.toHaveBeenCalled();
  });
});
