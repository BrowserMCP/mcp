import type { ButtonHTMLAttributes, ReactNode } from "react";

import { CircleAlertIcon } from "lucide-react";
import { browser } from "wxt/browser";

const BUTTON_VARIANTS = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  destructive: "bg-destructive text-white hover:bg-destructive/90",
  outline: "border border-input bg-background hover:bg-accent",
  ghost: "hover:bg-accent",
  link: "text-foreground underline-offset-4 hover:underline",
};

const BUTTON_SIZES = {
  default: "h-8 px-3",
  sm: "h-7 px-2.5 text-xs",
  /** Full width, for the popup's main actions */
  wide: "h-9 w-full px-3",
  icon: "size-8",
  inline: "h-auto p-0 text-xs",
};

/** The popup's buttons. Sizes are whole classes rather than overrides, so nothing has to merge Tailwind classes */
export function Button({
  variant = "default",
  size = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
      {...props}
    />
  );
}

/** A notice with an icon, a title and a description; `destructive` for what the user has to fix */
export function Alert({
  variant = "default",
  title,
  children,
}: {
  variant?: "default" | "destructive";
  title?: ReactNode;
  children: ReactNode;
}) {
  const destructive = variant === "destructive";
  return (
    <div
      role="alert"
      className={`flex gap-2.5 rounded-lg border px-3 py-2.5 ${destructive ? "border-destructive/40 text-destructive" : ""}`}
    >
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        <div
          className={
            destructive ? "text-destructive/90" : "text-muted-foreground"
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** An action's error */
export function ErrorAlert({ children }: { children: ReactNode }) {
  return <Alert variant="destructive">{children}</Alert>;
}

/** Opens a page in a new tab, which closes the popup */
export function openPage(url: string) {
  void browser.tabs.create({ url });
}
