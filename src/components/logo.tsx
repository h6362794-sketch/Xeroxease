import { cn } from "@/lib/utils";

export function LogoMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/xeroxease-logo.jpeg"
      alt="XeroxEase logo"
      width={size}
      height={size}
      className={cn("rounded-xl object-cover shadow-card", className)}
      style={{ width: size, height: size }}
    />
  );
}

export function LogoFull({ className, size = 40 }: { className?: string; size?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark size={size} />
      <span className="leading-tight">
        <span className="block font-extrabold tracking-tight text-white" style={{ fontSize: size * 0.45 }}>
          Xerox<span className="brand-gradient-text">Ease</span>
        </span>
        <span className="block text-[10px] uppercase tracking-[0.22em] text-zinc-400">
          Efficient Document Solutions
        </span>
      </span>
    </span>
  );
}
