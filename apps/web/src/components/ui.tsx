/**
 * Minimal primitives for Grok Desktop Portable, built against Grok Desktop tokens.
 *
 * Read `apps/desktop/DESIGN.md` before changing anything here. These follow
 * §5 (component stylings) and §4 (spacing, radius, elevation) and use only
 * semantic tokens — never raw hex.
 *
 * This is deliberately small. The shared `packages/ui` extraction is a later
 * phase; until then Light carries the few primitives it actually needs rather
 * than copying a registry it does not use.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Search as SearchIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Merge Tailwind classes with later values winning. */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/**
 * `sm` is for controls that sit inside a row or a toolbar, `md` for standalone
 * ones. Before the split every button was 36px, so a cluster of three read as
 * heavy as the content it acted on.
 */
type ControlSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // Charcoal Ink fill, off-white text (DESIGN.md §5).
  primary:
    "bg-primary text-primary-foreground hover:bg-primary-hover active:scale-[.98]",
  secondary:
    "bg-card text-foreground border border-input hover:bg-muted hover:border-input-hover active:scale-[.98]",
  ghost: "bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground active:scale-[.98]",
  danger:
    "bg-destructive-soft text-destructive border border-destructive/30 hover:bg-destructive hover:text-destructive-foreground active:scale-[.98]",
};

const BUTTON_SIZES: Record<ControlSize, string> = {
  sm: "h-7 gap-1.5 px-2 text-body-sm",
  md: "h-9 gap-2 px-3 text-body",
};

/** Standard action button. One primary per view (DESIGN.md §5). */
export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center rounded-md font-semibold",
        "transition-[background-color,border-color,color,transform]",
        "duration-150 ease-fluid disabled:opacity-48",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: the control has no text of its own (DESIGN.md §8). */
  "aria-label": string;
  size?: ControlSize;
  children: ReactNode;
}

/**
 * Square, transparent until hover (DESIGN.md §5).
 *
 * `md` is 36px, above the 34px standalone-target floor. `sm` is 28px, which
 * §6 permits for compact inline and auxiliary controls only — a row's close
 * button, a toolbar affordance — never for a standalone action.
 */
export function IconButton({
  size = "md",
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md",
        "text-muted-foreground transition-[background-color,color,transform]",
        "duration-150 ease-fluid hover:bg-accent/60 hover:text-foreground",
        "active:scale-[.98] disabled:opacity-48",
        size === "sm" ? "size-7" : "size-9",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Pure Surface panel with a hairline border (DESIGN.md §5). */
export function Card({
  children,
  className,
  /** Drop the inner padding so a list can own its own row rhythm. */
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card",
        flush ? "p-0" : "p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

/**
 * The shared list-row recipe.
 *
 * Rows are the primary navigation surface on every list Light has, so they are
 * defined once rather than re-derived per view. A resting row draws nothing:
 * hover tints with Accent Wash (DESIGN.md §7) and the selected row lifts onto
 * Pure Surface, which is the same treatment §5 gives an active sidebar item.
 */
export function rowClass({
  selected = false,
  className,
}: { selected?: boolean; className?: ClassValue } = {}): string {
  return cn(
    "group flex w-full min-w-0 items-center rounded-md text-left",
    "transition-[background-color,color] duration-150 ease-fluid",
    selected
      ? "bg-card text-foreground shadow-raised ring-1 ring-border/60"
      : "hover:bg-accent/60 focus-visible:bg-accent/60",
    "disabled:pointer-events-auto disabled:opacity-48",
    className,
  );
}

interface RowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

/** A whole-row action. The row is the button; it carries no nested one. */
export function Row({ selected = false, className, ...rest }: RowProps) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      className={rowClass({ selected, className })}
      {...rest}
    />
  );
}

/**
 * Search field with the icon inside the control.
 *
 * Resting state is a soft fill rather than a border, so a list page does not
 * open with a hard rectangle above it; focus raises it to Pure Surface.
 */
export function SearchField({
  label,
  value,
  onValueChange,
  placeholder,
  className,
}: {
  /** Accessible name. Visible labels are the rule; here the icon carries it. */
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cn("relative block", className)}>
      <span className="sr-only">{label}</span>
      <SearchIcon
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle-foreground"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder ?? label}
        className={cn(
          "h-9 w-full rounded-md border border-transparent bg-muted pl-9 pr-3",
          "text-body text-foreground outline-none",
          "transition-[background-color,border-color] duration-150 ease-fluid",
          "placeholder:text-subtle-foreground",
          "hover:bg-secondary focus:border-input focus:bg-card",
        )}
      />
    </label>
  );
}

/** Uppercase section label, 11px mono, Ink Tertiary (DESIGN.md §3). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 font-mono text-label font-semibold uppercase tracking-[0.06em] text-subtle-foreground">
      {children}
    </p>
  );
}

type Tone = "neutral" | "info" | "success" | "warning" | "destructive";

const TONE_STYLES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  destructive: "bg-destructive-soft text-destructive",
};

const TONE_DOTS: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

/**
 * Status chip: soft fill, matching ink, dot, and a label.
 *
 * Status is never colour alone (DESIGN.md §2), so the label is required.
 */
export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
        "text-label font-semibold",
        TONE_STYLES[tone],
      )}
    >
      <span className={cn("size-1.5 rounded-full", TONE_DOTS[tone])} aria-hidden="true" />
      {children}
    </span>
  );
}

/** Empty state: icon, one line, one action (DESIGN.md §5). */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="text-subtle-foreground" aria-hidden="true">
        {icon}
      </span>
      <h2 className="text-title-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-[52ch] text-body text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}

/**
 * A disclosure the product is required to make.
 *
 * Light is a control surface, not containment. The threat model says so and
 * the interface must too, so this is a primitive rather than ad-hoc copy.
 */
export function Disclosure({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md bg-warning-soft px-3 py-2 text-body-sm text-warning">
      {children}
    </p>
  );
}
