import { useState } from "react";

import { KeyRoundIcon, PauseIcon, PlayIcon } from "lucide-react";

import {
  type ConnectionStatus,
  sendBrowserControlMessage,
  TAB_GROUP_HEX,
  TAB_GROUP_TEXT,
  useBrowserControl,
} from "@browsermcp/extension-core/popup";

import { APP_NAME, UPDATE_EXTENSION_URL, UPDATE_SERVER_URL } from "./links";
import { Alert, Button, ErrorAlert, openPage } from "./ui";

/**
 * The popup's browser control: the connection to the Browser MCP server (or what to update), **Allow** for a new server, the AI apps using the browser with their tabs, and **Stop** / **Resume**
 */
export function BrowserControlPanel() {
  const [view, refresh] = useBrowserControl();
  const [error, setError] = useState<string | null>(null);

  if (!view) {
    return null;
  }

  const run = (action: () => Promise<void>) => async () => {
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
    await refresh();
  };

  const { connection } = view;
  const paired =
    connection.state === "connected" && connection.pairing === "paired";

  return (
    <div className="flex flex-col">
      {error && (
        <div className="px-4 pb-3">
          <ErrorAlert>{error}</ErrorAlert>
        </div>
      )}
      <ConnectionAlert
        connection={connection}
        legacyServer={view.legacyServer}
        onAllow={(publicKey) =>
          run(() => sendBrowserControlMessage("allowDaemon", { publicKey }))()
        }
      />

      {paired && (
        <section
          aria-labelledby="browser-control-apps"
          className="space-y-3 px-4 py-3"
        >
          <h2
            id="browser-control-apps"
            className="text-xs font-medium text-muted-foreground"
          >
            AI apps
          </h2>
          {view.apps.length === 0 ? (
            <p className="text-muted-foreground">
              No AI apps are using this browser.
            </p>
          ) : (
            <ul className="space-y-3">
              {view.apps.map((app) => (
                <li key={app.id}>
                  {/* The app's tab group as Chrome draws it: its name on its color, and a line in that color by its tabs */}
                  <span
                    className="inline-block max-w-full truncate rounded-md px-1.5 py-px text-xs font-medium"
                    style={{
                      backgroundColor: TAB_GROUP_HEX[app.color],
                      color: TAB_GROUP_TEXT[app.color],
                    }}
                  >
                    {app.name}
                  </span>
                  <ul
                    className="ms-1 mt-1 border-s-2 ps-1"
                    style={{ borderColor: TAB_GROUP_HEX[app.color] }}
                  >
                    {app.tabs.map((tab) => (
                      <li key={tab.tabId}>
                        <button
                          type="button"
                          title={tab.url}
                          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={run(() =>
                            sendBrowserControlMessage("switchToTab", {
                              tabId: tab.tabId,
                            }),
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {tab.title}
                          </span>
                          {tab.attached && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              In use
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="space-y-2 border-t px-4 py-3">
        {view.paused && (
          <p className="text-muted-foreground">
            Agents are paused until you resume them.
          </p>
        )}
        {view.paused ? (
          <Button
            size="wide"
            onClick={run(() => sendBrowserControlMessage("resumeAgents"))}
          >
            <PlayIcon />
            Resume
          </Button>
        ) : (
          <Button
            variant="destructive"
            size="wide"
            onClick={run(() => sendBrowserControlMessage("stopAgents"))}
          >
            <PauseIcon />
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * One of three states: connected (or waiting for **Allow**), waiting for the server, or an update to make. A 0.1.x server answering on its port counts as an outdated server
 */
function ConnectionAlert({
  connection,
  legacyServer,
  onAllow,
}: {
  connection: ConnectionStatus;
  legacyServer: boolean;
  onAllow: (publicKey: string) => void;
}) {
  if (connection.state === "connected") {
    return connection.pairing === "pending" ? (
      <AllowAlert connection={connection} onAllow={onAllow} />
    ) : (
      <>
        {legacyServer && <UpdateAlert kind="server" />}
        <p className="flex items-center gap-2 border-y bg-muted/60 px-4 py-2">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-success"
          />
          Connected to the {APP_NAME} server
        </p>
      </>
    );
  }
  if (connection.state === "updateExtension") {
    return <UpdateAlert kind="extension" />;
  }
  if (connection.state === "updateServer" || legacyServer) {
    return <UpdateAlert kind="server" />;
  }
  // Searching, another browser holds the connection, or the program on the port couldn't be verified
  if (connection.state === "untrusted") {
    return (
      <div className="px-4 pb-3">
        <Alert
          variant="destructive"
          title={`Waiting for the ${APP_NAME} server`}
        >
          The program on its port couldn't prove it's the {APP_NAME} server.
          Restart your AI app, and if this stays, check what else runs on ports
          9010 to 9012.
        </Alert>
      </div>
    );
  }
  return (
    <div role="alert" className="space-y-1 border-y bg-muted/60 px-4 py-2.5">
      <p className="flex items-center gap-2 font-medium">
        <span
          aria-hidden
          className="size-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/60 motion-reduce:animate-none"
        />
        Waiting for the {APP_NAME} server
      </p>
      <p className="ps-4 text-muted-foreground">
        {connection.state === "anotherBrowser"
          ? "An AI app is using a tab in that browser. This one connects once it's free."
          : `Start an AI app that uses ${APP_NAME}. The extension connects on its own.`}
      </p>
    </div>
  );
}

function AllowAlert({
  connection,
  onAllow,
}: {
  connection: Extract<ConnectionStatus, { state: "connected" }>;
  onAllow: (publicKey: string) => void;
}) {
  return (
    <section
      role="alert"
      aria-labelledby="browser-control-allow"
      className="space-y-3 border-t px-4 py-4"
    >
      <div className="flex gap-2">
        <KeyRoundIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="space-y-1">
          <h2 id="browser-control-allow" className="font-semibold">
            Allow {APP_NAME} on this computer?
          </h2>
          <p className="text-muted-foreground">
            Allow it only if you use {APP_NAME} in an AI app. The AI app shows
            the same code.
          </p>
        </div>
      </div>
      {connection.code && (
        <p className="rounded-lg bg-muted py-2.5 text-center font-mono text-lg font-medium tracking-wide">
          Code: {connection.code}
        </p>
      )}
      <Button size="wide" onClick={() => onAllow(connection.publicKey)}>
        Allow
      </Button>
    </section>
  );
}

function UpdateAlert({ kind }: { kind: "server" | "extension" }) {
  return (
    <div className="px-4 pb-3">
      <Alert variant="destructive" title={`Update the ${APP_NAME} ${kind}`}>
        {kind === "server"
          ? "Use @browsermcp/mcp@latest in your AI app's MCP config, then restart the AI app."
          : "Get the latest source and build it again, then click Reload for it in chrome://extensions."}
        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              openPage(
                kind === "server" ? UPDATE_SERVER_URL : UPDATE_EXTENSION_URL,
              )
            }
          >
            How to update
          </Button>
        </div>
      </Alert>
    </div>
  );
}
