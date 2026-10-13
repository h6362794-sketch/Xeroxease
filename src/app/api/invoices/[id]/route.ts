import { prisma } from "@/lib/prisma";
import { requireUser, isAdminRole } from "@/server/auth";
import { apiError, withErrorHandling } from "@/server/api-utils";
import { formatCurrencyINR } from "@/lib/utils";
import { BRAND } from "@/lib/constants";

export const runtime = "nodejs";

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { name: true, email: true, regNo: true, phone: true, branch: true, section: true, year: true } },
        files: { select: { originalName: true, pageCount: true } },
      },
    });
    if (!order) return apiError("Order not found.", 404);
    if (order.userId !== user.id && !isAdminRole(user.role)) {
      return apiError("You do not have access to this invoice.", 403);
    }

    // Finishing is driven by the fee actually charged, not by whether a custom page
    // range was used (the previous condition hid the line item for custom ranges).
    const finishing = Number(order.finishingFee) > 0 ? ["Finishing applied"] : [];

    const rows = order.files
      .map(
        (f, i) => `<tr><td>${i + 1}</td><td>${esc(f.originalName)}</td><td>${f.pageCount ?? "—"}</td></tr>`
      )
      .join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Invoice ${esc(order.orderNumber)} — ${BRAND.name}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f8fb; color: #0a1220; margin: 0; padding: 24px; }
  .card { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 8px 30px rgba(2,8,20,0.12); }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand img { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; }
  h1 { font-size: 22px; margin: 0; }
  .muted { color: #5b6b82; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e9edf3; }
  th { color: #5b6b82; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .totals td { border-bottom: none; padding: 4px 8px; }
  .grand { font-size: 18px; font-weight: 700; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #e9f2ff; color: #1d4ed8; }
  @media print { body { background: #fff; padding: 0; } .card { box-shadow: none; } .noprint { display: none; } }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <div class="brand">
        <img src="/brand/xeroxease-logo.jpeg" alt="XeroxEase logo" />
        <div>
          <h1>${BRAND.name}</h1>
          <div class="muted">${BRAND.tagline}</div>
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:700">Invoice ${esc(order.orderNumber)}</div>
        <div class="muted">${new Date(order.createdAt).toLocaleString("en-IN")}</div>
      </div>
    </div>
    <hr style="border:none;border-top:1px solid #e9edf3;margin:20px 0" />
    <div style="display:flex;gap:32px;flex-wrap:wrap">
      <div>
        <div class="muted">Billed to</div>
        <div style="font-weight:600">${esc(order.user.name)}</div>
        <div class="muted">${esc(order.user.email)} · ${esc(order.user.regNo ?? "")}</div>
        <div class="muted">${esc(order.user.branch ?? "")} ${esc(order.user.section ?? "")} · Year ${order.user.year ?? "—"}</div>
      </div>
      <div>
        <div class="muted">Payment status</div>
        <span class="badge">${esc(order.paymentStatus.replaceAll("_", " "))}</span>
      </div>
    </div>
    <table>
      <thead><tr><th>#</th><th>Document</th><th>Pages</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3" class="muted">No files attached</td></tr>`}</tbody>
    </table>
    <table class="totals">
      <tr><td>Print settings</td><td style="text-align:right">${esc(order.paperSize)} · ${order.colorMode === "COLOR" ? "Colour" : "B&W"} · ${order.sides === "DOUBLE" ? "Double side" : "Single side"} · ${order.copies} cop${order.copies > 1 ? "ies" : "y"}</td></tr>
      <tr><td>Billable pages</td><td style="text-align:right">${order.billablePages} @ ${formatCurrencyINR(Number(order.pricePerPage))}/page</td></tr>
      <tr><td>Finishing</td><td style="text-align:right">${finishing.length ? esc(finishing.join(", ")) : "—"} ${Number(order.finishingFee) > 0 ? "(" + formatCurrencyINR(Number(order.finishingFee)) + ")" : ""}</td></tr>
      <tr class="grand"><td>Total</td><td style="text-align:right">${formatCurrencyINR(Number(order.totalAmount))}</td></tr>
    </table>
    <p class="muted" style="margin-top:24px">Thank you for using ${BRAND.name}. This is a system-generated invoice.</p>
    <button class="noprint" onclick="window.print()" style="margin-top:12px;padding:10px 18px;border-radius:10px;border:none;background:#1d4ed8;color:#fff;font-weight:600;cursor:pointer">Download / Print Invoice</button>
  </div>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  });
}

export const dynamic = "force-dynamic";
