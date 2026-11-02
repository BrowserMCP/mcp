const ENABLE_STEPS =
  'Ask the user to open the Browser MCP popup on the tab you need and click "Enable control for this tab", or to turn off "Limit AI apps to tabs I enable" in its settings';

const plural = (count: number) => `${count} tab${count === 1 ? "" : "s"}`;

/** What `tab list` says when the user limited agents to the tabs they enable and enabled none, so it doesn't look like the tool is broken */
export function hiddenTabsMessage(hidden: number): string {
  return `No tabs are enabled for you. The browser has ${plural(hidden)} open, but the user hasn't enabled any for agents. ${ENABLE_STEPS}. Meanwhile, \`tab new <url>\` opens a tab of your own.`;
}

/** The line `tab list` adds when some tabs are enabled and others aren't */
export function moreHiddenTabsNote(hidden: number): string {
  return `(${hidden} more ${hidden === 1 ? "tab is" : "tabs are"} open but not enabled for agents. ${ENABLE_STEPS}.)`;
}
