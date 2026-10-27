# Security

Browser MCP drives your own signed-in browser, so we take reports about it seriously.

## Reporting a vulnerability

Please report it privately, not in a public issue:

- [Report it on GitHub](https://github.com/BrowserMCP/mcp/security/advisories/new) (private vulnerability reporting), or
- email [support@browsermcp.io](mailto:support@browsermcp.io) with "Security" in the subject.

Include what you found, how to reproduce it (the versions of the server and the extension, your browser and operating system) and what an attacker could do with it. We'll reply within a few days, tell you when it's fixed, and credit you in the release notes if you like.

## What counts

The parts of Browser MCP that decide who can drive your browser:

- **Pairing and the connection**: anything that lets a web page, another local user or another program on your computer control the browser without you clicking **Allow** after checking the six-digit code, or that gets past the daemon only listening on `127.0.0.1`.
- **The extension's own rules**: reaching incognito windows, browser or extension pages, or tabs while **Stop** is pressed.
- **The MCP server and the daemon**: reading or writing files or running programs outside what a browser tool call should allow, and leaking page content or credentials to anyone but the AI app that asked for them.

## Supported versions

The latest release of `@browsermcp/mcp` and of the extension. The server and the extension tell you when the other is too old for them, so update both.
