/**
 * Portable's primitives, as thin adapters over Fabrials UI so views keep their
 * names and props while rendering the house components (DESIGN.md).
 */

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { Search as SearchIcon } from "lucide-react";
import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button as FabrialsButton,
  Card as FabrialsCard,
  IconButton as FabrialsIconButton,
  StatePanel,
} from "@fabrials/ui";

/** Merge Tailwind classes with later values winning. */
const merge = extendTailwindMerge({
  extend: {classGroups: {"font-size": [{text: ["label", "body-sm", "body", "body-lg", "title-sm", "title", "title-lg", "display"]}]}},
});

export function cn(...values: ClassValue[]): string {
  return merge(clsx(values));
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

type ControlSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
}

const BUTTON_VARIANTS = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  danger: "destructive",
} as const;

export function Button({ variant = "secondary", size = "md", type = "button", ...rest }: ButtonProps) {
  return <FabrialsButton type={type} variant={BUTTON_VARIANTS[variant]} size={size === "sm" ? "sm" : "default"} {...rest} />;
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string;
  size?: ControlSize;
  children: ReactNode;
}

export function IconButton({ size = "md", type = "button", "aria-label": label, children, ...rest }: IconButtonProps) {
  return (
    <FabrialsIconButton type={type} label={label} tooltip={false} size={size === "sm" ? "icon-sm" : "icon"} {...rest}>
      {children}
    </FabrialsIconButton>
  );
}

export function Card({
  children,
  className,
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return <FabrialsCard className={cn(flush && "p-0", className)}>{children}</FabrialsCard>;
}

/** The shared list-row recipe: a resting row draws nothing; the selected row takes the accent surface. */
export function rowClass({
  selected = false,
  className,
}: { selected?: boolean; className?: ClassValue } = {}): string {
  return cn(
    "group flex w-full min-w-0 items-center rounded-md text-left",
    "transition-[background-color,color] duration-150 ease-fluid",
    selected
      ? "bg-accent text-accent-foreground"
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
  const id = useId();
  return (
    <label className={cn("relative block", className)}>
      <span className="sr-only">{label}</span>
      <SearchIcon
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle-foreground"
        aria-hidden="true"
      />
      <input
        id={id}
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

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-body-sm font-medium text-muted-foreground">{children}</p>;
}

type Tone = "neutral" | "info" | "success" | "warning" | "destructive";

export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge tone={tone === "destructive" ? "danger" : tone} dot>
      {children}
    </Badge>
  );
}

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
  return <StatePanel state="empty" icon={icon} title={title} description={description} actions={action} align="center" variant="inline" />;
}

export function Disclosure({ children }: { children: ReactNode }) {
  return (
    <Alert variant="warning" layout="inline">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
