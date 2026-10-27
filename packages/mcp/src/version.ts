import packageJSON from "../package.json";

/** `@browsermcp/mcp`'s version: the daemon's and the thin process's, compared to decide which daemon to use */
export const VERSION: string = packageJSON.version;

/** Compares `major.minor.patch` versions (a prerelease sorts before its release). Negative when `a` is older */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = "", prerelease] = version.split("-", 2);
    return {
      parts: core.split(".").map((part) => Number(part) || 0),
      prerelease,
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (left.prerelease === undefined) {
    return 1;
  }
  if (right.prerelease === undefined) {
    return -1;
  }
  return left.prerelease.localeCompare(right.prerelease, "en", {
    numeric: true,
  });
}
