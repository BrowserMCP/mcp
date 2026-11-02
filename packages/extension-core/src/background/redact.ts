/** Headers that carry credentials. Their values never leave the browser while redaction is on; their names, and the names of cookies, do */
const SECRET_HEADER =
  /^(cookie|set-cookie|authorization|proxy-authorization|x-xsrf-token|x-csrf-token|x-api-key|x-auth-token|x-amz-security-token)$/i;

const REDACTED = "(redacted)";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The header's value as an agent may see it: unchanged unless it carries credentials, else only what identifies it (cookie names, the authorization scheme) */
export function redactHeaderValue(name: string, value: string): string {
  if (!SECRET_HEADER.test(name)) {
    return value;
  }
  const isCookie = /^cookie$/i.test(name);
  if (isCookie || /^set-cookie$/i.test(name)) {
    const names = value
      .split(isCookie ? ";" : "\n")
      .map((part) => part.split("=")[0].trim())
      .filter(Boolean);
    return `(redacted: ${names.join(", ")})`;
  }
  const scheme = /^(Bearer|Basic|Digest|Negotiate)\s/i.exec(value)?.[1];
  return scheme ? `(redacted: ${scheme})` : REDACTED;
}

/** A CDP `Headers` object (name to value) with the credentials redacted */
function redactHeaders(headers: unknown): unknown {
  if (!isObject(headers)) {
    return headers;
  }
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      typeof value === "string" ? redactHeaderValue(name, value) : value,
    ]),
  );
}

/** `Fetch.requestPaused`'s response headers: a list of `{ name, value }` */
function redactHeaderEntries(entries: unknown): unknown {
  if (!Array.isArray(entries)) {
    return entries;
  }
  return entries.map((entry) =>
    isObject(entry) &&
    typeof entry.name === "string" &&
    typeof entry.value === "string"
      ? { ...entry, value: redactHeaderValue(entry.name, entry.value) }
      : entry,
  );
}

/** A list of `{ cookie }` (`associatedCookies`, `blockedCookies`) without the cookies' values */
function redactCookies(items: unknown): unknown {
  if (!Array.isArray(items)) {
    return items;
  }
  return items.map((item) =>
    isObject(item) && isObject(item.cookie)
      ? { ...item, cookie: { ...item.cookie, value: REDACTED } }
      : item,
  );
}

/** A copy of `object` whose `key` is `change(object[key])`, when `object` has it */
function update(
  object: unknown,
  key: string,
  change: (value: unknown) => unknown,
): unknown {
  return isObject(object) && key in object
    ? { ...object, [key]: change(object[key]) }
    : object;
}

type Redactor = (params: Json) => Json;

const requestHeaders: Redactor = (params) =>
  update(params, "request", (request) =>
    update(request, "headers", redactHeaders),
  ) as Json;

const responseHeaders: Redactor = (params) =>
  update(params, "response", (response) =>
    update(
      update(response, "headers", redactHeaders),
      "requestHeaders",
      redactHeaders,
    ),
  ) as Json;

/** The CDP events that carry HTTP headers or cookies, and what to redact in each */
const REDACTORS: Record<string, Redactor> = {
  "Network.requestWillBeSent": (params) =>
    update(requestHeaders(params), "redirectResponse", (response) =>
      update(response, "headers", redactHeaders),
    ) as Json,
  "Network.requestWillBeSentExtraInfo": (params) =>
    update(
      update(params, "headers", redactHeaders),
      "associatedCookies",
      redactCookies,
    ) as Json,
  "Network.responseReceived": responseHeaders,
  "Network.responseReceivedExtraInfo": (params) =>
    update(
      update(params, "headers", redactHeaders),
      "blockedCookies",
      redactCookies,
    ) as Json,
  "Network.webSocketWillSendHandshakeRequest": requestHeaders,
  "Network.webSocketHandshakeResponseReceived": responseHeaders,
  "Fetch.requestPaused": (params) =>
    update(
      requestHeaders(params),
      "responseHeaders",
      redactHeaderEntries,
    ) as Json,
};

/** The event's params with the credentials in its headers and cookies redacted, or the params themselves when the event carries none */
export function redactCdpEvent(method: string, params: unknown): unknown {
  const redactor = Object.hasOwn(REDACTORS, method)
    ? REDACTORS[method]
    : undefined;
  return redactor && isObject(params) ? redactor(params) : params;
}
