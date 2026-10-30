/** The MCP server's `instructions`: the three-line workflow. The thin process sends it in `initialize` */
export const INSTRUCTIONS = `Browser MCP controls the user's Chrome through the \`browser\` tool:
1. Act in batches: put every step you can predict in one call (targets like getByLabel('Email') work without a snapshot).
2. Look with \`snapshot -i\` or \`find "<text>"\`; read a whole page with \`get text --max all\`.
3. Re-snapshot after navigating: refs from an older page fail.`;
