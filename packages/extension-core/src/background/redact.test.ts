import { describe, expect, it } from "vitest";

import { redactCdpEvent, redactHeaderValue } from "./redact";

describe("redactHeaderValue", () => {
  it("keeps cookie names, not values", () => {
    expect(
      redactHeaderValue("Cookie", "SESSIONID=abc; _ga=GA1.1; lbs=!x"),
    ).toBe("(redacted: SESSIONID, _ga, lbs)");
    expect(
      redactHeaderValue("set-cookie", "XSRF-TOKEN=r; Path=/\nlbs=!w; Secure"),
    ).toBe("(redacted: XSRF-TOKEN, lbs)");
  });

  it("keeps the authorization scheme only", () => {
    expect(redactHeaderValue("Authorization", "Bearer eyJhbGci")).toBe(
      "(redacted: Bearer)",
    );
    expect(redactHeaderValue("Authorization", "opaque")).toBe("(redacted)");
    expect(redactHeaderValue("X-XSRF-Token", "wISz1azM")).toBe("(redacted)");
  });

  it("leaves other headers alone", () => {
    expect(redactHeaderValue("content-type", "application/json")).toBe(
      "application/json",
    );
  });
});

describe("redactCdpEvent", () => {
  it("redacts the headers of requests and responses, without changing the event", () => {
    const params = {
      requestId: "1",
      request: {
        url: "https://example.com/",
        headers: { Authorization: "Bearer abc", Accept: "*/*" },
      },
      redirectResponse: { headers: { "Set-Cookie": "a=1; Path=/" } },
    };
    expect(redactCdpEvent("Network.requestWillBeSent", params)).toEqual({
      requestId: "1",
      request: {
        url: "https://example.com/",
        headers: { Authorization: "(redacted: Bearer)", Accept: "*/*" },
      },
      redirectResponse: { headers: { "Set-Cookie": "(redacted: a)" } },
    });
    expect(params.request.headers.Authorization).toBe("Bearer abc");

    expect(
      redactCdpEvent("Network.responseReceived", {
        response: {
          headers: { "set-cookie": "s=1" },
          requestHeaders: { cookie: "s=1; t=2" },
        },
      }),
    ).toEqual({
      response: {
        headers: { "set-cookie": "(redacted: s)" },
        requestHeaders: { cookie: "(redacted: s, t)" },
      },
    });
  });

  it("redacts the extra info's headers and cookie values", () => {
    expect(
      redactCdpEvent("Network.requestWillBeSentExtraInfo", {
        headers: { cookie: "SID=secret" },
        associatedCookies: [
          { blockedReasons: [], cookie: { name: "SID", value: "secret" } },
        ],
      }),
    ).toEqual({
      headers: { cookie: "(redacted: SID)" },
      associatedCookies: [
        { blockedReasons: [], cookie: { name: "SID", value: "(redacted)" } },
      ],
    });
    expect(
      redactCdpEvent("Network.responseReceivedExtraInfo", {
        headers: { "set-cookie": "SID=secret" },
        blockedCookies: [{ cookie: { name: "SID", value: "secret" } }],
      }),
    ).toEqual({
      headers: { "set-cookie": "(redacted: SID)" },
      blockedCookies: [{ cookie: { name: "SID", value: "(redacted)" } }],
    });
  });

  it("redacts paused fetches, request and response headers", () => {
    expect(
      redactCdpEvent("Fetch.requestPaused", {
        request: { headers: { Cookie: "a=1" } },
        responseHeaders: [
          { name: "Set-Cookie", value: "a=1" },
          { name: "Content-Type", value: "text/html" },
        ],
      }),
    ).toEqual({
      request: { headers: { Cookie: "(redacted: a)" } },
      responseHeaders: [
        { name: "Set-Cookie", value: "(redacted: a)" },
        { name: "Content-Type", value: "text/html" },
      ],
    });
  });

  it("leaves other events, and events without headers, as they are", () => {
    const params = { timestamp: 1 };
    expect(redactCdpEvent("Page.loadEventFired", params)).toBe(params);
    expect(redactCdpEvent("toString", params)).toBe(params);
    expect(
      redactCdpEvent("Network.requestWillBeSent", undefined),
    ).toBeUndefined();
    expect(
      redactCdpEvent("Network.responseReceived", { response: {} }),
    ).toEqual({
      response: {},
    });
  });
});
