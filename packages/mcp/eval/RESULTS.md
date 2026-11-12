# Eval: the `browser` tool

The eval compares four tool sets on local fixture pages (`src/commands/testing/fixtures.ts`), each driving the same headless Chromium through `LaunchedBackend`:

| Tool set     | What the model gets                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cli-string` | The `browser` tool; `commands` is one string of lines                                                                                    |
| `cli-array`  | The `browser` tool; `commands` is an array of lines                                                                                      |
| `typed`      | 0.1.x-style tools (`browser_navigate`, `browser_click {element, ref}`, `browser_type`, …), each action answering with a full AI snapshot |
| `playwright` | One `execute` tool running Playwright code in Node, like Playwriter                                                                      |

Tasks: the httpbin-like form (checked against the server's received post), the Hacker-News-like list ("new" page, top 3 titles), the repo page (stars, latest release), login (account number behind a sign-in), search and paginate (all 5 "lamp" results over 2 pages), and a modal covering the page.

The nine harder tasks (`EVAL_TASKS=hard`; pages in `src/commands/testing/hard-fixtures.ts`) are each checked against what the page posted to the fixture server, not the model's word, except `newtab`, whose answer exists only on the tab the page opens:

| Task           | What makes it hard                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `signup`       | Fields appear as earlier ones are answered, an "add row" button, and no `<label>`s: each field's name is only the text beside it |
| `iframe`       | A card form in a cross-origin iframe (its own process), with fields that reformat as you type                                    |
| `shadow`       | Settings built from custom elements two shadow roots deep, with an ARIA switch and a listbox menu built from divs                |
| `zoom`         | Small, tightly packed day buttons far down the page, at 150% browser zoom; every click is recorded, so one miss fails            |
| `spa`          | Routes by `pushState`, each view loading slowly after a placeholder, and a list that re-renders under the model                  |
| `autocomplete` | A city field that suggests only on key presses (not on `input` events) and counts only when a suggestion is picked               |
| `drag`         | A board whose cards move only by dragging with the pointer, with no menu or keyboard alternative                                 |
| `dialog`       | Deleting asks with the browser's `confirm()`                                                                                     |
| `newtab`       | The invoice opens in a new tab from a script, with a one-time key, so it can't be opened by URL                                  |

`pnpm --filter @browsermcp/mcp eval` without a key still runs scripted solutions of the hard tasks with the `browser` tool, which checks the pages and the checks.

Run it with `pnpm --filter @browsermcp/mcp eval` and `ANTHROPIC_API_KEY` set. `EVAL_MODELS` (default `claude-haiku-5-5,claude-sonnet-5-5`), `EVAL_CONFIGS`, `EVAL_TASKS` and `EVAL_REPEAT` narrow or widen it; turns are capped at 15 per task, and the run prints a table and writes `eval/results/<time>.json`. At 2 models × 4 tool sets × 6 tasks, a run should cost a few dollars (Haiku 5.5 is $0.10/$0.50 per MTok, Sonnet 5.5 $2/$10), well under the $20 cap.

## Status

The six easy tasks and the feed don't separate the tool sets on success: every run of them has succeeded. The hard tasks do: on 2026-11-12 the 0.1.x-style `typed` tools failed `drag`, `dialog` and `newtab` every time, with both models (see "The hard tasks" below).

One model run on 2026-10-25: Haiku 5.5 and Sonnet 5.5, each tool set once per task (`eval/results/` is gitignored). Every run succeeded, so these tasks don't separate the tool sets on success; they do on tokens. With one run per cell, differences of a turn or two are noise.

## Without a model: the shortest scripted solutions

What each tool set sends and reads back for the best possible solution (one run, characters ≈ tokens × 4). Read-back is what lands in the context and is re-read on every later turn.

| Tools      | Task | Calls | Input chars (sent) | Result chars (read back) |
| ---------- | ---- | ----- | ------------------ | ------------------------ |
| cli-string | form | 1     | 414                | 581                      |
| cli-string | list | 1     | 118                | 523                      |
| cli-array  | form | 1     | 425                | 581                      |
| cli-array  | list | 1     | 122                | 523                      |
| typed      | form | 9     | 429                | 14604                    |
| typed      | list | 2     | 66                 | 13647                    |
| playwright | form | 1     | 581                | 179                      |
| playwright | list | 1     | 233                | 121                      |

- `typed` costs 25–30× more read-back than the command lines, and 9 turns for the form instead of 1, since every action returns a snapshot.
- `playwright` reads back the least when the model already knows the page (it returns only what the code returns), but sends the most, and it can't look at a page it doesn't know without snapshots of its own. The model runs will show whether that holds when the page is unknown.
- The array form costs about 3% more to send than the string (`"`, `,` per line) and nothing more to read.

## With models

Totals over the six tasks:

| Model      | Tools      | Success | Turns | Input tokens | Output tokens | Tool results (chars) |
| ---------- | ---------- | ------- | ----- | ------------ | ------------- | -------------------- |
| Haiku 5.5  | cli-string | 6/6     | 24    | 60,019       | 2,394         | 13,278               |
| Haiku 5.5  | cli-array  | 6/6     | 23    | 54,141       | 2,310         | 12,766               |
| Haiku 5.5  | typed      | 6/6     | 24    | 101,084      | 3,398         | 70,122               |
| Haiku 5.5  | playwright | 6/6     | 19    | 29,613       | 2,555         | 19,690               |
| Sonnet 5.5 | cli-string | 6/6     | 20    | 44,758       | 1,409         | 12,095               |
| Sonnet 5.5 | cli-array  | 6/6     | 20    | 44,861       | 1,487         | 12,109               |
| Sonnet 5.5 | typed      | 6/6     | 19    | 57,841       | 2,371         | 42,651               |
| Sonnet 5.5 | playwright | 6/6     | 19    | 21,521       | 2,021         | 7,557                |

Tool definitions (`messages.countTokens` with and without the tools, so including the API's tool-use overhead): cli-string 1,359 tokens, cli-array 1,355, typed 1,337, playwright 571. Every turn pays for the definition again.

- **Command lines against the 0.1.x-style tools:** 23–41% fewer input tokens and 3.5–5× less tool output, with the same success and turns. The gap is widest on the form (Haiku 6.2K against 30.1K input tokens), where typed tools return a snapshot after each field.
- **One string against an array:** no difference worth acting on (Haiku's list task took 6 turns with the string and 4 with the array, which is within run-to-run noise; Sonnet's runs were identical).
- **Playwright code** used the fewest tokens: about half the command lines' input. Most of the gap is the definition (about 800 tokens more for the `browser` tool, paid on every turn: about 19K of Haiku's 60K); the rest is compact results, since the code returns only what it asks for. It isn't an option for Browser MCP as it stands: the code runs in the daemon, in Node, with the user's files, network and processes, so a page that talks the model into writing the wrong code gets it run on the user's machine (the issue rejects oh-my-pi's model-writes-code interface for this reason), and it bypasses the output policy (caps, never echoing typed text, hidden tabs, blocked sites).
- **What to do with it:** the definition is the cheapest lever, so it was trimmed (below).

### The trimmed definition

The description now lists the everyday commands with short syntax and only names the rest (`hover`, `drag`, `upload`, `dialog`, `console`, `errors`, `requests`, `request`, `styles`, `cdp`), whose syntax `help <command>` prints: 1,154 characters as JSON instead of 2,545, and 749 tokens by the API's count instead of 1,359 (the array form: 817). Re-run on 2026-10-26 with the same tasks and models:

| Model      | Tools      | Success | Turns | Input tokens | Output tokens | Tool results (chars) |
| ---------- | ---------- | ------- | ----- | ------------ | ------------- | -------------------- |
| Haiku 5.5  | cli-string | 6/6     | 21    | 34,688       | 1,810         | 12,103               |
| Haiku 5.5  | cli-array  | 6/6     | 21    | 35,017       | 2,086         | 12,254               |
| Sonnet 5.5 | cli-string | 6/6     | 19    | 28,753       | 1,373         | 11,308               |
| Sonnet 5.5 | cli-array  | 6/6     | 21    | 33,252       | 1,472         | 11,116               |

Input tokens fell 42% for Haiku (60.0K to 34.7K) and 36% for Sonnet (44.8K to 28.8K), with no more turns, so models didn't need `help` to find what the description no longer spells out. Playwright code is now 15–25% cheaper instead of about half.

### 2.1.0: `scroll`, and fewer hidden commands

2.1.0 adds `scroll`, folds `errors` into `console`, drops `styles` and names `cdp` only with `--caps cdp`. The definition stays about the same size (1,147 characters without `cdp`). A seventh task, the feed, needs scrolling: 40 posts load 10 at a time as the end of the list comes into view, and the answer is post 37. Run on 2026-10-27, `cli-string` only:

| Model      | Tasks         | Success | Turns | Input tokens | Output tokens | Tool results (chars) |
| ---------- | ------------- | ------- | ----- | ------------ | ------------- | -------------------- |
| Haiku 5.5  | the six above | 6/6     | 22    | 35,900       | 1,944         | 12,008               |
| Haiku 5.5  | feed          | 1/1     | 5     | 8,350        | 676           | 2,975                |
| Sonnet 5.5 | the six above | 6/6     | 21    | 31,457       | 1,362         | 11,084               |
| Sonnet 5.5 | feed          | 1/1     | 6     | 8,597        | 511           | 1,630                |

The six tasks are within a turn or two and about 10% of input tokens of the 2026-10-26 run, which is run-to-run noise. Both models solved the feed. The results don't record the commands, so they don't show whether the models scrolled with `scroll` or with `eval`.

### The hard tasks

Run on 2026-11-12: Haiku 5.5 and Sonnet 5.5, the four tool sets, the nine hard tasks, 3 times each (216 runs, $2.02). Successes per task, Haiku / Sonnet, out of 3 each:

| Tools      | signup | iframe | shadow | zoom  | spa   | autocomplete | drag      | dialog    | newtab    | Total         |
| ---------- | ------ | ------ | ------ | ----- | ----- | ------------ | --------- | --------- | --------- | ------------- |
| cli-string | 3 / 3  | 3 / 3  | 3 / 3  | 3 / 3 | 3 / 3 | **2** / 3    | 3 / 3     | 3 / 3     | 3 / 3     | 26/27 · 27/27 |
| cli-array  | 3 / 3  | 3 / 3  | 3 / 3  | 3 / 3 | 3 / 3 | 3 / 3        | 3 / 3     | 3 / 3     | 3 / 3     | 27/27 · 27/27 |
| typed      | 3 / 3  | 3 / 3  | 3 / 3  | 3 / 3 | 3 / 3 | 3 / 3        | **0 / 0** | **0 / 0** | **0 / 0** | 18/27 · 18/27 |
| playwright | 3 / 3  | 3 / 3  | 3 / 3  | 3 / 3 | 3 / 3 | 3 / 3        | 3 / 3     | 3 / 3     | 3 / 3     | 27/27 · 27/27 |

Averages per run over the nine tasks:

| Model      | Tools      | Success | Turns | Input tokens | Output tokens | Tool results (chars) | Cost (27 runs) |
| ---------- | ---------- | ------- | ----- | ------------ | ------------- | -------------------- | -------------- |
| Haiku 5.5  | cli-string | 26/27   | 6.1   | 13,349       | 593           | 2,971                | $0.02          |
| Haiku 5.5  | cli-array  | 27/27   | 6.3   | 15,348       | 699           | 3,336                | $0.02          |
| Haiku 5.5  | typed      | 18/27   | 6.7   | 38,768       | 1,147         | 14,567               | $0.06          |
| Haiku 5.5  | playwright | 27/27   | 5.3   | 8,949        | 722           | 2,500                | $0.02          |
| Sonnet 5.5 | cli-string | 27/27   | 5.6   | 10,321       | 371           | 2,484                | $0.31          |
| Sonnet 5.5 | cli-array  | 27/27   | 5.8   | 12,182       | 429           | 2,791                | $0.35          |
| Sonnet 5.5 | typed      | 18/27   | 6.5   | 32,208       | 884           | 12,895               | $0.92          |
| Sonnet 5.5 | playwright | 27/27   | 4.5   | 6,469        | 513           | 2,755                | $0.32          |

- **What separates tool sets:** `drag`, `dialog` and `newtab` are capabilities, not skill. `typed` has no drag, no way to answer a dialog (Playwright dismisses it, so nothing is deleted) and no tabs, and both models said so rather than guessing. The `browser` tool and Playwright code have all three.
- **What separates models:** only `autocomplete`, and only for Haiku with one string (1 of 3 failed after 15 turns). Every other hard task passed with both models.
- **What doesn't separate anything on success:** `signup`, `iframe`, `shadow`, `zoom` and `spa`. They still separate on turns and tokens: `typed` reads back 4–5× the characters, and Haiku's `signup` took 86K input tokens with `typed` against 31K with one string.
- **`type` doesn't press keys:** the `browser` tool's `type` inserts text, so the autocomplete never suggests anything; `type --slowly` presses keys, but no run found it from the description. The command-line runs of `autocomplete` took 8–12 turns (Haiku's failure among them) against 6–7 for Playwright code, trying `fill`, `press ArrowDown` and `eval` first. Making `type` press keys (or saying in its usage line when to use `--slowly`) is the change these numbers point to.
- **After `type` pressed keys by default** (2026-11-12, `autocomplete` only, `cli-string` and `cli-array`, 3 runs each per model, $0.10): 12/12 succeeded. Sonnet took 7–10 turns (7 in four of six runs) and used `type` at once; Haiku took 7–15, usually trying `fill` on the city first, which still sets the value without keys.
- **Zoom:** the `browser` tool clicks at coordinates (`preparePointer()`), and no run missed a day at 150%. The engine's own test (`engine.test.ts`, "clicks land at 125% zoom") covers the same thing; the misses in BrowserMCP/mcp#207 came through the extension, which `LaunchedBackend` doesn't use.

### A `form` command (BrowserMCP/mcp#218)

BrowserMCP/mcp#218 adds a `form` command (fields grouped by question, with values and options), the nearby text as `hint` in `snapshot -i`, and reports of what appeared after each action. Applied to this tree and run on `signup` with `cli-string`, 3 times per model ($0.07):

| Model      | Version      | Success | Turns | Input tokens | Tool results (chars) |
| ---------- | ------------ | ------- | ----- | ------------ | -------------------- |
| Haiku 5.5  | without #218 | 3/3     | 8.3   | 30,641       | —                    |
| Haiku 5.5  | with #218    | 3/3     | 8.3   | 27,229       | 9,081                |
| Sonnet 5.5 | without #218 | 3/3     | 7.0   | 18,998       | —                    |
| Sonnet 5.5 | with #218    | 3/3     | 7.3   | 20,481       | 6,956                |

Every run called `form`, and the reports of new fields (`+ textbox [ref=e27]`) replaced re-snapshots, but turns and tokens stayed within noise, since the models already managed this form from the full snapshot's text. One label was wrong: `form` named the terms checkbox `"+ Add row"`, the button before it, instead of the text after it. This task doesn't show a gain; a form with more fields than a snapshot shows at once might.

## Decision: one string or an array of lines

**One string.** The model runs showed no difference between the two shapes. It's what the issue's examples and playwright-cli/agent-browser users write, it's slightly cheaper to send, and it keeps quoting simple (a line's double quotes are escaped once, by JSON). The engine accepts both shapes anyway (an array's items may each hold several lines), so a model that sends an array still works, and switching the advertised schema is a one-line change in `src/tools/browser.ts`.

## What the prototype changed in the design

- **Main-frame refs without a frame prefix.** Playwright numbers a document's refs with its frame (`f2e12`), and the main document gets a new number each time it navigates, so after the first navigation every ref looked like an iframe's. The engine shows the main document's refs as `e12` and adds the prefix seen at the last snapshot back when resolving them, so a ref from before a navigation still fails (as stale) instead of hitting the new page's `e12`. Iframe refs keep theirs (`f1e3`).
- **Refs change when an element's role or name changes** (Playwright keeps a ref only while both match), e.g. a "Save" button that becomes "Saved". That ref then fails as stale; the error says to re-snapshot or use a locator.
- **`-i` drops layout tables.** On the Hacker-News-like page, `-i` was 6.5K characters, mostly `table`/`rowgroup`/`row`/`cell` wrappers; dropping unnamed layout wrappers and empty cells (keeping rows and list items that group several kept elements) brought it to 3.1K, and the repo page from 4.6K to 3.7K.
- **`find` paths show only named ancestors and landmarks**, not `table > rowgroup > row > cell > …`.
- **URL notes:** an action's `→ <url>` note is relative when the origin didn't change, and dropped when the trailer shows the same URL, which brought the form flow from 635 to 581 characters (budget: 600).
- **Console noise:** the favicon's 404, which Chrome logs as a console error, isn't counted as a new error.
- **Calls, not steps, are serialized per tab:** a call runs whole before another session's call on the same tab, so batches don't interleave.
