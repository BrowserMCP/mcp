/**
 * Parses the `browser` tool's command lines: one command per line, blank lines and `#` comments ignored, arguments with spaces double-quoted with JSON escaping (single quotes work too), except `eval`'s code, which keeps its backslashes for JavaScript.
 *
 * `parseCommands` only splits lines; the engine tokenizes each line before the call's first step runs, so a quoting mistake anywhere in a call runs none of it, and is reported against its own line. Errors give a column, never the text, since it may be something the agent types into a page.
 *
 * Playwright locators (`getByRole('button', { name: 'Submit' })`), CSS attribute selectors (`a[title="x y"]`) and JSON (`{"offline":true}`) are single tokens even with spaces inside, since brackets and quotes nest.
 */

export type Token = {
  text: string;
  /** Quoted in the source, so never a flag */
  quoted: boolean;
};

export type CommandLine = {
  /** 1-based step number within the call */
  step: number;
  /** The line as written. It may hold typed text, so messages echo it only for commands without any */
  source: string;
};

export class ParseError extends Error {}

/** Splits the tool's input into command lines. Accepts one string (lines separated by newlines) or an array of lines */
export function parseCommands(input: string | string[]): CommandLine[] {
  const lines = (Array.isArray(input) ? input : [input]).flatMap((entry) =>
    entry.split(/\r?\n/),
  );
  const commands: CommandLine[] = [];
  for (const raw of lines) {
    const source = raw.trim();
    if (!source || source.startsWith("#")) continue;
    commands.push({ step: commands.length + 1, source });
  }
  return commands;
}

/** The line's first word: the command's name, found without tokenizing the rest */
export function commandName(source: string): string {
  return source.split(/\s/, 1)[0] ?? "";
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const verbatim = commandName(line) === "eval";
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) {
      i++;
      continue;
    }
    if (line[i] === '"' || line[i] === "'") {
      const end = scanQuoted(line, i, line[i]);
      tokens.push({ text: unquote(line, i, end, verbatim), quoted: true });
      i = end;
      continue;
    }
    // A bare word, which may hold balanced brackets and quoted strings (locators, attribute selectors, JSON)
    const start = i;
    const stack: string[] = [];
    while (i < line.length) {
      const ch = line[i];
      if (stack.length === 0 && /\s/.test(ch)) break;
      if (ch in CLOSERS) {
        stack.push(CLOSERS[ch]);
        i++;
      } else if (stack.length > 0 && ch === stack.at(-1)) {
        stack.pop();
        i++;
      } else if (stack.length > 0 && (ch === "'" || ch === '"' || ch === "`")) {
        i = scanQuoted(line, i, ch);
      } else if (stack.length > 0 && ch === "/" && isRegexStart(line, i)) {
        i = scanQuoted(line, i, "/");
        while (/[a-z]/.test(line[i] ?? "")) i++;
      } else {
        i++;
      }
    }
    if (stack.length > 0) {
      throw new ParseError(
        `Unbalanced brackets in the argument at column ${start + 1}: missing ${stack.reverse().join("")}`,
      );
    }
    tokens.push({ text: line.slice(start, i), quoted: false });
  }
  return tokens;
}

/** Returns the index after the closing quote, skipping backslash escapes */
function scanQuoted(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") i += 2;
    else if (line[i] === quote) return i + 1;
    else i++;
  }
  throw new ParseError(
    `Missing closing ${quote} for the quote at column ${start + 1}`,
  );
}

/** Decodes a quoted argument (`line[start]` to before `end`) with JSON escaping (`eval`'s code is verbatim but for its own quote); in single quotes, \\' is a quote and " needs no escape */
function unquote(
  line: string,
  start: number,
  end: number,
  verbatim: boolean,
): string {
  if (verbatim) {
    // JavaScript has its own escapes (\n, \d, \u00a0), so only the quote's own escape is decoded
    const quote = line[start];
    return line
      .slice(start + 1, end - 1)
      .replace(/\\([^])/g, (match, next: string) =>
        next === quote ? quote : match,
      );
  }
  let literal = line.slice(start, end);
  if (line[start] === "'") {
    literal = `"${literal.slice(1, -1).replace(/\\(.)|"/g, (match, escaped: string | undefined) => (escaped === "'" ? "'" : escaped === undefined ? '\\"' : match))}"`;
  }
  try {
    return JSON.parse(literal) as string;
  } catch {
    throw new ParseError(
      `Bad escaping in the quoted argument at column ${start + 1}. Escape like JSON (\\" and \\\\)`,
    );
  }
}

function isRegexStart(line: string, i: number): boolean {
  const before = line.slice(0, i).trimEnd().at(-1);
  return before === "(" || before === "," || before === ":";
}

export type ParsedArgs = {
  positional: Token[];
  flags: Record<string, string | true>;
};

/** Which flags a command takes: `true` for a flag with a value (`--max 500`), `false` for a switch (`--submit`) */
export type FlagSpec = Record<string, boolean>;

/** Splits tokens into positional arguments and flags. Quoted tokens are always positional */
export function parseArgs(
  command: string,
  tokens: Token[],
  spec: FlagSpec,
): ParsedArgs {
  const positional: Token[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const isFlag =
      !token.quoted && /^(--[a-z][a-z-]*|-[a-z])$/.test(token.text);
    if (!isFlag) {
      positional.push(token);
      continue;
    }
    const name = token.text.replace(/^-+/, "");
    if (!(name in spec)) {
      throw new ParseError(
        `${command} has no ${token.text} flag. Run \`help ${command}\``,
      );
    }
    if (spec[name]) {
      const value = tokens[i + 1];
      if (!value) throw new ParseError(`${token.text} needs a value`);
      flags[name] = value.text;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}
