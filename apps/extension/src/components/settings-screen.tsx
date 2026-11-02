import { type FormEvent, useState } from "react";

import { ArrowLeftIcon } from "lucide-react";

import {
  isValidGrantMinutes,
  MAX_GRANT_MINUTES,
  MIN_GRANT_MINUTES,
  sendBrowserControlMessage,
  useBrowserControl,
} from "@browsermcp/extension-core/popup";
import { RELAY_PORTS, isValidRelayPort } from "@browsermcp/protocol";

import { Button, ErrorAlert } from "./ui";

/**
 * The popup's settings: the port of a server started with `--port`, and whether credentials in headers and cookies are redacted. Add a setting only when users can't do without it, since each one is more for every user to read
 */
export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [view, refresh] = useBrowserControl();
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
    await refresh();
  };

  return (
    <div className="w-80 text-[13px]">
      <div className="flex items-center gap-1 px-2 py-2.5">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={onBack}>
          <ArrowLeftIcon className="size-5 rtl:rotate-180" />
        </Button>
        <h1 className="text-[15px] font-semibold">Settings</h1>
      </div>
      {error && (
        <div className="px-4 pb-3">
          <ErrorAlert>{error}</ErrorAlert>
        </div>
      )}
      {view && (
        <div className="border-t px-4 py-3">
          <PortSetting
            // Remounts with the saved port, so the field shows it
            key={view.relayPort ?? "default"}
            relayPort={view.relayPort}
            onSave={(port) =>
              run(() => sendBrowserControlMessage("setRelayPort", { port }))
            }
          />
        </div>
      )}
      {view && (
        <div className="border-t px-4 py-3">
          <TabAccessSetting
            // Remounts with the saved time, so the field shows it
            key={view.tabAccess.defaultMinutes}
            restricted={view.tabAccess.restricted}
            defaultMinutes={view.tabAccess.defaultMinutes}
            onRestrict={(restricted) =>
              run(() =>
                sendBrowserControlMessage("setRestrictTabs", { restricted }),
              )
            }
            onSaveMinutes={(minutes) =>
              run(() =>
                sendBrowserControlMessage("setDefaultGrantMinutes", {
                  minutes,
                }),
              )
            }
          />
        </div>
      )}
      {view && (
        <div className="border-t px-4 py-3">
          <RedactHeadersSetting
            enabled={view.redactHeaders}
            onChange={(enabled) =>
              run(() =>
                sendBrowserControlMessage("setRedactHeaders", { enabled }),
              )
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * Whether AI apps get every tab or only the ones the user enables in the popup, and for how long **Enable for this tab** lasts
 */
function TabAccessSetting({
  restricted,
  defaultMinutes,
  onRestrict,
  onSaveMinutes,
}: {
  restricted: boolean;
  defaultMinutes: number;
  onRestrict: (restricted: boolean) => void;
  onSaveMinutes: (minutes: number) => void;
}) {
  const [value, setValue] = useState(defaultMinutes.toString());
  const [invalid, setInvalid] = useState(false);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!/^\d+$/.test(text) || !isValidGrantMinutes(Number(text))) {
      setInvalid(true);
      return;
    }
    onSaveMinutes(Number(text));
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          className="size-4"
          checked={restricted}
          aria-describedby="settings-restrict-help"
          onChange={(event) => onRestrict(event.target.checked)}
        />
        Limit AI apps to tabs I enable
      </label>
      <p id="settings-restrict-help" className="text-xs text-muted-foreground">
        {restricted
          ? "AI apps can only use tabs they open themselves and tabs you enable from this extension's popup. Your other tabs stay hidden from them."
          : "AI apps can use any tab in this browser."}
      </p>
      {restricted && (
        <form onSubmit={save} className="space-y-2">
          <label htmlFor="settings-minutes" className="block font-medium">
            Access time for enabled tabs (minutes)
          </label>
          <div className="flex gap-2">
            <input
              id="settings-minutes"
              className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
              inputMode="numeric"
              value={value}
              aria-invalid={invalid}
              aria-describedby="settings-minutes-help"
              onChange={(event) => {
                setValue(event.target.value);
                setInvalid(false);
              }}
            />
            <Button type="submit" variant="outline">
              Save
            </Button>
          </div>
          <p
            id="settings-minutes-help"
            className={`text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`}
          >
            {invalid
              ? `Enter a whole number from ${MIN_GRANT_MINUTES} to ${MAX_GRANT_MINUTES}.`
              : "How long a tab stays enabled after you click Enable control for this tab. The default is 60."}
          </p>
        </form>
      )}
    </div>
  );
}

/**
 * Redacting credentials (cookies, authorization and CSRF tokens) in the headers and cookies, in the browser, so their values never reach the server or the AI app. On by default
 */
function RedactHeadersSetting({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          className="size-4"
          checked={enabled}
          aria-describedby="settings-redact-help"
          onChange={(event) => onChange(event.target.checked)}
        />
        Hide cookies and tokens from AI apps
      </label>
      <p id="settings-redact-help" className="text-xs text-muted-foreground">
        {enabled
          ? "Cookie values and authorization or CSRF tokens in network requests are removed in the browser before AI apps can see them. Their names stay."
          : "AI apps can see the values of cookies and authorization or CSRF tokens in network requests, and could pass them on to a model or a website."}
      </p>
    </div>
  );
}

/**
 * The port of a server started with `--port`: the default ports (`RELAY_PORTS`) are tried while it's empty
 */
function PortSetting({
  relayPort,
  onSave,
}: {
  relayPort: number | null;
  onSave: (port: number | null) => void;
}) {
  const [value, setValue] = useState(relayPort?.toString() ?? "");
  const [invalid, setInvalid] = useState(false);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (text === "") {
      onSave(null);
      return;
    }
    const port = Number(text);
    if (!/^\d+$/.test(text) || !isValidRelayPort(port)) {
      setInvalid(true);
      return;
    }
    onSave(port);
  };

  return (
    <form onSubmit={save} className="space-y-2">
      <label htmlFor="settings-port" className="block font-medium">
        Server port
      </label>
      <div className="flex gap-2">
        <input
          id="settings-port"
          className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
          inputMode="numeric"
          placeholder={RELAY_PORTS.join(", ")}
          value={value}
          aria-invalid={invalid}
          aria-describedby="settings-port-help"
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
        />
        <Button type="submit" variant="outline">
          Save
        </Button>
      </div>
      <p
        id="settings-port-help"
        className={`text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`}
      >
        {invalid
          ? "Enter a port from 1024 to 65535, other than 9009."
          : "Only if the server runs with --port. Enter the same port here. Leave it empty for the default ports."}
      </p>
      {relayPort !== null && (
        <Button
          type="button"
          variant="link"
          size="inline"
          onClick={() => onSave(null)}
        >
          Use default ports
        </Button>
      )}
    </form>
  );
}
