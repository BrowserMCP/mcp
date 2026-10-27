/**
 * Raw CDP for `--caps cdp`: commands on a CDP session of the agent's own per tab, buffered events, and cleanup when the tab is released (domains it enabled, a paused debugger, interception, emulation and network overrides).
 */
import type { CDPSession } from "playwright-core";

import { BUFFER_SIZE, type CdpState } from "@/commands/tab-state";

export function newCdpState(session: CDPSession): CdpState {
  const state: CdpState = {
    session,
    enabled: new Set(),
    subscribed: new Set(),
    events: [],
    used: new Set(),
    paused: false,
    listeners: new Map(),
  };
  session.on("Debugger.paused", () => {
    state.paused = true;
  });
  session.on("Debugger.resumed", () => {
    state.paused = false;
  });
  return state;
}

export async function sendCdp(
  state: CdpState,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  const result = await state.session.send(
    method as "Runtime.evaluate",
    params as never,
  );
  const [domain, command] = method.split(".");
  if (command === "enable") state.enabled.add(domain);
  if (command === "disable") state.enabled.delete(domain);
  state.used.add(method);
  return result;
}

export function subscribe(state: CdpState, event: string) {
  if (state.subscribed.has(event)) return;
  state.subscribed.add(event);
  const listener = (params: unknown) => {
    state.events.push({ method: event, params });
    if (state.events.length > BUFFER_SIZE) state.events.shift();
  };
  state.listeners.set(event, listener);
  state.session.on(event as "Debugger.paused", listener as never);
}

/** Overrides `cdp` may have set, and how to clear each. Run on release, newest domain state first */
const RESETS: {
  when: RegExp;
  method: string;
  params?: Record<string, unknown>;
}[] = [
  { when: /^Fetch\./, method: "Fetch.disable" },
  {
    when: /^Emulation\.setDeviceMetricsOverride$/,
    method: "Emulation.clearDeviceMetricsOverride",
  },
  {
    when: /^Emulation\.setGeolocationOverride$/,
    method: "Emulation.clearGeolocationOverride",
  },
  {
    when: /^Emulation\.setEmulatedMedia$/,
    method: "Emulation.setEmulatedMedia",
    params: { media: "", features: [] },
  },
  {
    when: /^Emulation\.setCPUThrottlingRate$/,
    method: "Emulation.setCPUThrottlingRate",
    params: { rate: 1 },
  },
  {
    when: /^Emulation\.setTimezoneOverride$/,
    method: "Emulation.setTimezoneOverride",
    params: { timezoneId: "" },
  },
  {
    when: /^Emulation\.setLocaleOverride$/,
    method: "Emulation.setLocaleOverride",
    params: {},
  },
  {
    when: /^Emulation\.setTouchEmulationEnabled$/,
    method: "Emulation.setTouchEmulationEnabled",
    params: { enabled: false },
  },
  {
    when: /^Emulation\.setScriptExecutionDisabled$/,
    method: "Emulation.setScriptExecutionDisabled",
    params: { value: false },
  },
  {
    when: /^Emulation\.setIdleOverride$/,
    method: "Emulation.clearIdleOverride",
  },
  {
    when: /^Network\.(emulateNetworkConditions|overrideNetworkState)/,
    method: "Network.emulateNetworkConditions",
    params: {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    },
  },
  {
    when: /^Network\.setExtraHTTPHeaders$/,
    method: "Network.setExtraHTTPHeaders",
    params: { headers: {} },
  },
  {
    when: /^Network\.setBlockedURLs$/,
    method: "Network.setBlockedURLs",
    params: { urls: [] },
  },
  {
    when: /^Network\.setCacheDisabled$/,
    method: "Network.setCacheDisabled",
    params: { cacheDisabled: false },
  },
  {
    when: /^Network\.setBypassServiceWorker$/,
    method: "Network.setBypassServiceWorker",
    params: { bypass: false },
  },
  {
    when: /^Page\.setBypassCSP$/,
    method: "Page.setBypassCSP",
    params: { enabled: false },
  },
  { when: /^DOM\.setBreakpoint|^DOMDebugger\./, method: "DOMDebugger.disable" },
  {
    when: /^Debugger\.setPauseOnExceptions$/,
    method: "Debugger.setPauseOnExceptions",
    params: { state: "none" },
  },
];

/** Undoes what `cdp` did on the tab, then detaches its session. Errors are ignored: the tab may be gone */
export async function cleanupCdp(state: CdpState): Promise<void> {
  const send = (method: string, params?: Record<string, unknown>) =>
    state.session
      .send(method as "Runtime.evaluate", params as never)
      .catch(() => {});
  if (state.paused || state.enabled.has("Debugger")) {
    await send("Debugger.setBreakpointsActive", { active: false });
    await send("Debugger.resume");
  }
  const done = new Set<string>();
  for (const used of state.used) {
    for (const reset of RESETS) {
      if (reset.when.test(used) && !done.has(reset.method)) {
        done.add(reset.method);
        await send(reset.method, reset.params);
      }
    }
  }
  for (const domain of state.enabled) await send(`${domain}.disable`);
  for (const [event, listener] of state.listeners) {
    state.session.off(event as "Debugger.paused", listener as never);
  }
  await state.session.detach().catch(() => {});
}
