import type { RawData, WebSocket } from "ws";

import type { RpcRequest, RpcResponse } from "@/contracts";

type MethodMap = Record<string, { params: unknown; result: unknown }>;

export type RpcHandlers<In extends MethodMap> = {
  [M in keyof In]: (params: In[M]["params"]) => Promise<In[M]["result"]>;
};

/** How long a request waits for its response by default */
export const RPC_TIMEOUT_MS = 30_000;
/** How long the daemon lets one `tools/call` run before answering with an error. The thin process waits a little longer, so the daemon's answer arrives first */
export const TOOL_CALL_TIMEOUT_MS = 5 * 60_000;

/**
 * JSON-RPC-style requests in both directions over one WebSocket, between the daemon and a thin process (after hello/welcome). `Out` is what this side calls, `In` what it answers
 */
export class RpcPeer<Out extends MethodMap, In extends MethodMap> {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly ws: WebSocket,
    private readonly handlers: RpcHandlers<In>,
  ) {
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => this.rejectAll(new Error("Connection closed")));
  }

  get open(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  /** Requests awaiting a response */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Rejects after `timeoutMs` (`RPC_TIMEOUT_MS` by default) without a response */
  request<M extends keyof Out & string>(
    method: M,
    params: Out[M]["params"],
    { timeoutMs = RPC_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<Out[M]["result"]> {
    if (!this.open) {
      return Promise.reject(new Error("Connection closed"));
    }
    const id = this.nextId++;
    const message: RpcRequest = { id, method, params };
    this.ws.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`No answer to ${method} within ${seconds(timeoutMs)}`),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
    });
  }

  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }

  private onMessage(data: RawData) {
    let message: Partial<
      RpcRequest & { result: unknown; error: { message: string } }
    >;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    if (typeof message.method === "string") {
      void this.answer(message.id, message.method, message.params);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private async answer(id: number, method: string, params: unknown) {
    let response: RpcResponse;
    const handler = (
      this.handlers as Record<string, (params: unknown) => Promise<unknown>>
    )[method];
    if (!handler) {
      response = { id, error: { message: `Unknown method: ${method}` } };
    } else {
      try {
        response = { id, result: await handler(params) };
      } catch (error) {
        response = { id, error: { message: errorMessage(error) } };
      }
    }
    if (this.open) {
      this.ws.send(JSON.stringify(response));
    }
  }

  private rejectAll(error: Error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `30 s`, `5 min` */
export function seconds(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0
    ? `${ms / 60_000} min`
    : `${Math.round(ms / 1000)} s`;
}

/** Rejects with `message` if `promise` doesn't settle within `ms` */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
