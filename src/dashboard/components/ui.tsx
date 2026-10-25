import { Check, Copy, Globe2, Loader2, Monitor, Smartphone, Tablet, X } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { colorFor, flag, initials } from "../lib/format";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "money";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: "bg-brand-600 text-white hover:bg-brand-700 shadow-sm",
    money: "bg-money-600 text-white hover:bg-money-700 shadow-sm",
    secondary: "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
    ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
        styles[variant],
        className,
      )}
      {...rest}
      disabled={loading || rest.disabled}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("card", className)}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("h-5 w-5 animate-spin text-zinc-400", className)} />;
}

export function Loading({ className }: { className?: string }) {
  return (
    <div className={cx("flex items-center justify-center py-10", className)}>
      <Spinner />
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-zinc-400">{icon}</div>}
      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</div>
      {children && <div className="mt-1 max-w-sm text-sm text-zinc-500">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; help?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition", checked ? "bg-brand-600" : "bg-zinc-300 dark:bg-zinc-700")}
      >
        <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition", checked ? "left-[18px]" : "left-0.5")} />
      </button>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {help && <span className="block text-xs text-zinc-500">{help}</span>}
      </span>
    </label>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  size = "sm",
}: {
  tabs: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            "rounded-md font-medium transition",
            size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
            value === t.value
              ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("card w-full shadow-xl", wide ? "max-w-4xl" : "max-w-lg")}>
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      className={className}
      onClick={() => {
        const done = () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        };
        // navigator.clipboard only exists in secure contexts; self-hosted instances often run over plain HTTP.
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(done, () => {});
          return;
        }
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          if (document.execCommand("copy")) done();
        } finally {
          ta.remove();
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-money-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cx("group relative", className)}>
      <pre className="scrollbar-thin overflow-x-auto rounded-xl bg-zinc-950 p-4 pr-24 font-mono text-xs leading-relaxed text-zinc-100 dark:bg-black">
        <code>{code}</code>
      </pre>
      <CopyButton text={code} className="absolute top-2.5 right-2.5 !border-zinc-700 !bg-zinc-800 !text-zinc-100" />
    </div>
  );
}

export function Badge({ children, color = "zinc" }: { children: ReactNode; color?: "zinc" | "green" | "red" | "brand" | "amber" }) {
  const styles = {
    zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    green: "bg-money-50 text-money-700 dark:bg-money-500/10 dark:text-money-400",
    red: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400",
    brand: "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  };
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", styles[color])}>{children}</span>;
}

export function Delta({ value, invert }: { value: number | null; invert?: boolean }) {
  if (value === null || !Number.isFinite(value)) return null;
  const up = value >= 0;
  const good = invert ? !up : up;
  if (Math.abs(value) < 0.0005) return <span className="text-xs text-zinc-400">0%</span>;
  return (
    <span className={cx("text-xs font-medium tabular", good ? "text-money-600 dark:text-money-400" : "text-red-500")}>
      {up ? "↑" : "↓"} {Math.abs(value * 100) >= 1000 ? ">999" : Math.abs(value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0)}%
    </span>
  );
}

export function Avatar({ name, image, size = 32 }: { name: string; image?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (image && !failed) {
    return <img src={image} alt="" onError={() => setFailed(true)} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: colorFor(name), fontSize: size * 0.38 }}
    >
      {initials(name) || "?"}
    </span>
  );
}

export function Favicon({ domain, size = 16 }: { domain?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!domain || failed) return <Globe2 className="shrink-0 text-zinc-400" style={{ width: size, height: size }} />;
  return <img src={`/api/favicon/${domain}`} alt="" width={size} height={size} onError={() => setFailed(true)} className="shrink-0 rounded-sm" loading="lazy" />;
}

export function Flag({ country, className }: { country?: string | null; className?: string }) {
  return <span className={cx("shrink-0 leading-none", className)}>{flag(country)}</span>;
}

export function DeviceIcon({ device, className = "h-4 w-4" }: { device?: string | null; className?: string }) {
  if (device === "mobile") return <Smartphone className={cx("shrink-0 text-zinc-400", className)} />;
  if (device === "tablet") return <Tablet className={cx("shrink-0 text-zinc-400", className)} />;
  return <Monitor className={cx("shrink-0 text-zinc-400", className)} />;
}

/** Simple dropdown anchored to a button. */
export function Dropdown({ button, children, align = "left", className }: { button: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{button(open)}</div>
      {open && (
        <div className={cx("card absolute z-40 mt-1.5 min-w-[200px] p-1 shadow-lg", align === "right" ? "right-0" : "left-0", className)}>{children(() => setOpen(false))}</div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, children, active, className }: { onClick?: () => void; children: ReactNode; active?: boolean; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-800",
        active && "bg-zinc-100 font-medium dark:bg-zinc-800",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{title}</h3>
          {description && <p className="mt-1 text-sm text-zinc-500">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </Card>
  );
}
