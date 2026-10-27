import type {
  CommandEngine,
  CreateCommandEngine,
  SessionInfo,
} from "@/contracts";

/**
 * A `CommandEngine` for testing the daemon and the thin process without the real `browser` tool. Its one tool, `browser`, takes lines such as `echo <text>`, `sleep <ms>`, `app`, `caps`, `read <path>`, `write <path> <text>`, `unavailable` and `tabs`
 */
export const createStubEngine: CreateCommandEngine = ({ backend }) => {
  const sessions = new Map<string, SessionInfo>();
  let inFlight = 0;

  const engine: CommandEngine & { sessions: typeof sessions } = {
    sessions,
    tools: () => [
      {
        name: "browser",
        description: "Stub browser tool",
        inputSchema: {
          type: "object",
          properties: { commands: { type: "string" } },
          required: ["commands"],
        },
      },
    ],
    instructions: () => "Stub instructions",
    openSession: (session) => void sessions.set(session.id, session),
    closeSession: async (sessionId) => void sessions.delete(sessionId),
    busy: () => inFlight > 0,
    async callTool(sessionId, _name, args) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`No session ${sessionId}`);
      }
      inFlight++;
      try {
        const [command = "", ...rest] = String(args?.commands ?? "").split(" ");
        const argument = rest.join(" ");
        let text: string;
        switch (command) {
          case "echo":
            text = argument;
            break;
          case "sleep":
            await new Promise((resolve) =>
              setTimeout(resolve, Number(argument)),
            );
            text = "slept";
            break;
          case "app":
            text = `${session.app.id} ${session.app.name}`;
            break;
          case "caps":
            text = session.capabilities.join(",");
            break;
          case "pid":
            text = String(process.pid);
            break;
          case "read": {
            const file = await session.io.readFile(argument);
            text = `${file.name} ${file.mimeType} ${file.buffer.toString()}`;
            break;
          }
          case "write": {
            const [path = "", ...content] = rest;
            text = await session.io.writeFile(
              path,
              Buffer.from(content.join(" ")),
            );
            break;
          }
          case "unavailable":
            text = backend.unavailableReason() ?? "available";
            break;
          case "tabs":
            text = JSON.stringify(backend.tabs());
            break;
          default:
            throw new Error(`Unknown stub command: ${command}`);
        }
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      } finally {
        inFlight--;
      }
    },
  };
  return engine;
};
