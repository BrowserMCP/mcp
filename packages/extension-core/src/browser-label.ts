/** The longest name the user can give a browser profile (`ExtensionState.label`), in characters */
export const MAX_BROWSER_LABEL_LENGTH = 40;

/**
 * The name the user typed for this browser profile as the extension keeps and sends it: whitespace (line breaks and tabs too) collapsed to single spaces, trimmed and cut to `MAX_BROWSER_LABEL_LENGTH` characters (whole characters, so an emoji isn't split). Null when nothing is left, which means unset
 */
export function normalizeBrowserLabel(
  label: string | null | undefined,
): string | null {
  const collapsed = (label ?? "").replace(/\s+/g, " ").trim();
  const capped = Array.from(collapsed)
    .slice(0, MAX_BROWSER_LABEL_LENGTH)
    .join("")
    .trimEnd();
  return capped || null;
}
