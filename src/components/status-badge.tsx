import { Badge } from "./ui";
import { statusMeta, PAYMENT_STATUS_META } from "@/lib/status-meta";

export function StatusBadge({ status }: { status: string }) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  return (
    <Badge className={meta.color}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

export function PaymentStatusBadge({ status }: { status: string }) {
  const meta = PAYMENT_STATUS_META[status] ?? { label: status, color: "text-slate-300 bg-slate-500/10 border-slate-500/20", icon: statusMeta(status).icon };
  const Icon = meta.icon;
  return (
    <Badge className={meta.color}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}
