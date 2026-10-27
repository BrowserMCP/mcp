/** Output limits and the errors written for the model */

/** Default cap per read command */
export const READ_CAP = 10_000;
/** `--max` can raise a read's cap up to this */
export const READ_CAP_MAX = 50_000;
/** Cap for a whole response */
export const RESPONSE_CAP = 50_000;
/** Images per response (screenshots); more are left out with a note */
export const MAX_IMAGES = 3;

/** An error whose message is meant for the model as is */
export class StepError extends Error {}

/** The cap for a read: `--max N`, at most `READ_CAP_MAX` */
export function readCap(flag: string | true | undefined): number {
  if (flag === undefined || flag === true) return READ_CAP;
  const value = Number(flag);
  if (!Number.isInteger(value) || value <= 0) {
    throw new StepError(`--max takes a number of characters, e.g. --max 2000`);
  }
  return Math.min(value, READ_CAP_MAX);
}

/**
 * Cuts text to `max` characters at a line break when there's one nearby, and says how to narrow it
 */
export function cap(
  text: string,
  max: number,
  hint = 'narrow it with `find "<text>"`, a target (`snapshot <target>`), `--depth N` or `-i`',
): string {
  if (text.length <= max) return text;
  let cut = text.lastIndexOf("\n", max);
  if (cut < max * 0.8) cut = max;
  const more =
    max < READ_CAP_MAX ? `, raise it with --max (up to ${READ_CAP_MAX})` : "";
  return `${text.slice(0, cut)}\n… cut at ${cut} of ${text.length} characters: ${hint}${more}`;
}

/** Keeps the end of a log (the newest entries) when it's over `max` */
export function capTail(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.indexOf("\n", text.length - max);
  if (start < 0) start = text.length - max;
  return `… ${start} earlier characters cut; add --filter or raise --max\n${text.slice(start + 1)}`;
}

/** Turns a Playwright error into one line for the model, without its call log */
export function errorMessage(error: unknown): string {
  if (error instanceof StepError) return error.message;
  const raw = error instanceof Error ? error.message : String(error);
  let message = raw.split("\n")[0];
  message = message.replace(
    /^(page|locator|frame|elementHandle|keyboard|mouse|browserContext|cdpSession)\.\w+: /,
    "",
  );
  message = message.replace(/^Error: /, "");
  if (/Target page, context or browser has been closed/.test(message)) {
    return "The tab closed or was released. Run `tab list` and `tab select <id>`, or `goto <url>`";
  }
  return message;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Formats a value as compact JSON for `eval` and `cdp` */
export function compactJson(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
