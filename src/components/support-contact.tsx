import { Phone, LifeBuoy } from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeSupportPhone } from "@/lib/support";

/**
 * Configurable helpline. Rendered on login, signup and the student dashboard.
 *
 * Accessibility: a real anchor with an accessible name, generous 44px touch
 * target, visible focus ring, and readable contrast. When no valid number is
 * configured it renders a non-interactive fallback — never a broken call link.
 */
export function SupportContact({
  className,
  variant = "inline",
}: {
  className?: string;
  variant?: "inline" | "card" | "compact";
}) {
  const phone = normalizeSupportPhone(process.env.NEXT_PUBLIC_SUPPORT_PHONE);
  const isDev = process.env.NODE_ENV !== "production";

  const content = phone ? (
    <a
      href={`tel:${phone.tel}`}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-[#b49aff]",
        "hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60",
        "transition-colors",
        className
      )}
      aria-label={`Call the XeroxEase helpline at ${phone.display}`}
    >
      <Phone className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        <span className="text-zinc-400 font-normal">Helpline: </span>
        <span className="underline decoration-white/20 underline-offset-2">{phone.display}</span>
      </span>
    </a>
  ) : (
    <p className={cn("flex items-center gap-2 px-3 py-2 text-xs text-zinc-500", className)}>
      <LifeBuoy className="h-4 w-4 shrink-0" aria-hidden="true" />
      {isDev ? (
        <span>
          Helpline not configured. Set <code className="text-zinc-400">NEXT_PUBLIC_SUPPORT_PHONE</code> to enable
          call links.
        </span>
      ) : (
        <span>Need help? Ask at the print desk.</span>
      )}
    </p>
  );

  if (variant === "card") {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-2 py-1">
        <p className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          Need help?
        </p>
        {content}
      </div>
    );
  }

  if (variant === "compact") {
    return <div className={cn("flex items-center", className)}>{content}</div>;
  }

  return <div className={className}>{content}</div>;
}
