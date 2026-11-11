/** The MCP server's `instructions`: the three-line workflow. The thin process sends it in `initialize`, before it knows how many browsers are connected, so it says nothing about several: agents learn of them from `tab list` (which names each tab's browser while several are connected) and `help` (which then lists `browser`) */
export const INSTRUCTIONS = `Browser MCP controls the user's Chrome through the \`browser\` tool:
1. Act in batches: put every step you can predict in one call (targets like getByLabel('Email') work without a snapshot).
2. Look with \`snapshot -i\` or \`find "<text>"\`; read a whole page with \`get text --max all\`.
3. Re-snapshot after navigating: refs from an older page fail.`;
