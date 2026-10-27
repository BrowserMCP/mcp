import http from "node:http";

/**
 * Serves test pages on a random port from a map of path → HTML. Pages are reachable as `http://127.0.0.1:<port>` and `http://localhost:<port>`, which Chromium treats as different sites, so an iframe from the other one runs out of process
 */
export async function startFixtureServer(pages: Record<string, string>) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const page = pages[url.pathname];
    if (page === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    crossSiteUrl: (path: string) => `http://localhost:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
