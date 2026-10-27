/**
 * Fixture pages for the engine's tests, token budgets and the eval, served on 127.0.0.1 at a random port: a form like httpbin's, a list like Hacker News, a repo page like GitHub's, a login, a search with pages, a modal, a feed that loads more as it scrolls, and pages for scrolling, iframes, shadow DOM, dialogs, uploads, covered elements and popups.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

const STORIES = [
  "Show HN: A tiny database in 500 lines",
  "The history of the semicolon",
  "Why we moved back to a monolith",
  "Rust in the Linux kernel: a year later",
  "An illustrated guide to TCP congestion control",
  "Launch HN: Acme (YC W26) – Invoices for robots",
  "How SQLite tests itself",
  "The unreasonable effectiveness of plain text",
  "Ask HN: What are you reading this month?",
  "A visual explanation of hash tables",
  "Building a CPU in a spreadsheet",
  "Typography for programmers",
  "Postgres as a queue, revisited",
  "The quiet death of the RSS reader",
  "Notes on writing a compiler in a weekend",
];

const NEW_STORIES = [
  "Fresh: A minimal HTTP server in Zig",
  "Fresh: My homelab, five years on",
  "Fresh: Understanding B-trees by drawing them",
  "Fresh: The case for boring technology",
  "Fresh: A new font for terminals",
];

function storyList(stories: string[], newPage: boolean) {
  const rows = stories
    .map(
      (
        title,
        i,
      ) => `<tr class="athing"><td class="rank">${i + 1}.</td><td class="title"><a href="/item?id=${i + 1}">${escape(title)}</a> <span class="site">(example.com)</span></td></tr>
<tr><td></td><td class="subtext">${(i * 37) % 400} points by user${i} ${i + 1} hours ago | <a href="/item?id=${i + 1}">${i * 3} comments</a></td></tr>`,
    )
    .join("\n");
  return page(
    newPage ? "New Links | Hacker Newz" : "Hacker Newz",
    `<table id="hnmain"><tr><td><table><tr><td><b><a href="/list">Hacker Newz</a></b> <a href="/newest">new</a> | <a href="/past">past</a> | <a href="/comments">comments</a> | <a href="/ask">ask</a> | <a href="/show">show</a> | <a href="/jobs">jobs</a> | <a href="/submit">submit</a></td><td><a href="/login">login</a></td></tr></table></td></tr>
<tr><td><table>${rows}</table></td></tr><tr><td><a href="${newPage ? "/newest?p=2" : "/list?p=2"}">More</a></td></tr></table>`,
  );
}

const FILES = [
  "src",
  "docs",
  "tests",
  ".github",
  "package.json",
  "README.md",
  "LICENSE",
  "tsconfig.json",
];

const REPO = page(
  "acme/widget: Widgets for everyone",
  `<header><nav aria-label="Global"><a href="/">Home</a> <a href="/explore">Explore</a> <a href="/marketplace">Marketplace</a> <input type="search" aria-label="Search or jump to…" placeholder="Search"> <a href="/login">Sign in</a> <a href="/signup">Sign up</a></nav></header>
<main><div><h1><a href="/acme">acme</a> / <strong><a href="/repo">widget</a></strong></h1> <span>Public</span>
<button>Watch 42</button> <button>Fork 7</button> <button aria-label="Star this repository">Star 1.2k</button></div>
<nav aria-label="Repository"><a href="/repo" aria-current="page">Code</a> <a href="/repo/issues">Issues 12</a> <a href="/repo/pulls">Pull requests 3</a> <a href="/repo/actions">Actions</a> <a href="/repo/wiki">Wiki</a> <a href="/repo/settings">Settings</a></nav>
<div><button aria-haspopup="menu">main</button> <a href="/repo/branches">4 branches</a> <a href="/repo/tags">9 tags</a> <button>Go to file</button> <button>Code</button></div>
<table aria-label="Files"><thead><tr><th>Name</th><th>Last commit</th><th>When</th></tr></thead><tbody>
${FILES.map((name, i) => `<tr><td><a href="/repo/blob/${name}">${name}</a></td><td><a href="/repo/commit/${i}">Update ${name} for the 2.0 release</a></td><td>${i + 2} days ago</td></tr>`).join("\n")}
</tbody></table>
<article><h2>README.md</h2><p>Widget is a library for making widgets. It has no dependencies and works everywhere.</p><h3>Install</h3><pre>npm install widget</pre><h3>Usage</h3><p>Call <code>widget()</code> and you get a widget.</p></article>
<aside aria-label="About"><h2>About</h2><p>Widgets for everyone</p><a href="https://widget.example">widget.example</a><ul><li><a href="/topics/widgets">widgets</a></li><li><a href="/topics/ui">ui</a></li></ul><h2>Releases 9</h2><a href="/repo/releases/v2.0.0">v2.0.0 Latest</a><h2>Contributors 5</h2></aside></main>
<footer><a href="/terms">Terms</a> <a href="/privacy">Privacy</a> <a href="/status">Status</a></footer>`,
);

const FORM = page(
  "Pizza order",
  `<form method="post" action="/post">
<p><label>Customer name: <input name="custname"></label></p>
<p><label>Telephone: <input type="tel" name="custtel"></label></p>
<p><label>E-mail address: <input type="email" name="custemail"></label></p>
<fieldset><legend>Pizza Size</legend>
<p><label><input type="radio" name="size" value="small"> Small</label></p>
<p><label><input type="radio" name="size" value="medium"> Medium</label></p>
<p><label><input type="radio" name="size" value="large"> Large</label></p></fieldset>
<fieldset><legend>Pizza Toppings</legend>
<p><label><input type="checkbox" name="topping" value="bacon"> Bacon</label></p>
<p><label><input type="checkbox" name="topping" value="cheese"> Extra Cheese</label></p>
<p><label><input type="checkbox" name="topping" value="onion"> Onion</label></p>
<p><label><input type="checkbox" name="topping" value="mushroom"> Mushroom</label></p></fieldset>
<p><label>Preferred delivery time: <input type="time" min="11:00" max="21:00" step="900" name="delivery"></label></p>
<p><label>Delivery instructions: <textarea name="comments"></textarea></label></p>
<p><button>Submit order</button></p></form>`,
);

const LOGIN = page(
  "Sign in",
  `<main><h1>Sign in to Acme</h1><form method="post" action="/login"><p><label for="u">Username</label> <input id="u" name="username" autocomplete="username"></p><p><label for="p">Password</label> <input id="p" type="password" name="password"></p><p><button>Sign in</button></p></form></main>`,
);

const PRODUCTS = Array.from({ length: 23 }, (_, i) => ({
  name: `${["Red", "Blue", "Green", "Black", "White"][i % 5]} ${["kettle", "lamp", "chair", "mug", "desk"][Math.floor(i / 5) % 5]} ${i + 1}`,
  price: 10 + ((i * 7) % 90),
}));

function search(query: string, pageNumber: number) {
  const matches = PRODUCTS.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  );
  const perPage = 3;
  const pages = Math.max(1, Math.ceil(matches.length / perPage));
  const shown = matches.slice((pageNumber - 1) * perPage, pageNumber * perPage);
  return page(
    query ? `Search: ${escape(query)}` : "Shop",
    `<main><h1>Shop</h1><form action="/search" role="search"><input name="q" aria-label="Search products" value="${escape(query)}"><button>Search</button></form>
${
  query
    ? `<p>${matches.length} results for “${escape(query)}”</p><ul>${shown.map((p) => `<li><a href="/product/${encodeURIComponent(p.name)}">${escape(p.name)}</a> — $${p.price}</li>`).join("")}</ul>
<nav aria-label="Pagination">${pageNumber > 1 ? `<a href="/search?q=${encodeURIComponent(query)}&page=${pageNumber - 1}">Previous</a>` : ""} Page ${pageNumber} of ${pages} ${pageNumber < pages ? `<a href="/search?q=${encodeURIComponent(query)}&page=${pageNumber + 1}">Next</a>` : ""}</nav>`
    : ""
}</main>`,
  );
}

const MODAL = page(
  "Newsletter",
  `<main><h1>Our blog</h1><p>Read our latest posts.</p><button id="read" onclick="document.getElementById('out').textContent='Article opened'">Read article</button><p id="out"></p></main>
<div id="modal" role="dialog" aria-modal="true" aria-label="Subscribe" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center"><div style="background:white;padding:20px"><h2>Subscribe to our newsletter</h2><input aria-label="Your email"><button>Subscribe</button> <button aria-label="Close" onclick="document.getElementById('modal').remove()">×</button></div></div>`,
);

const TESTS: Record<string, string> = {
  "/iframe": page(
    "Frames",
    `<h1>Outer</h1><iframe title="Inner" src="/iframe-inner" style="width:400px;height:200px"></iframe>`,
  ),
  "/iframe-inner": page(
    "Inner",
    `<button onclick="this.textContent='Inner clicked'">Inner button</button><label>Inner field <input></label>`,
  ),
  "/shadow": page(
    "Shadow",
    `<div id="host"></div><p id="out"></p><script>const root=document.getElementById('host').attachShadow({mode:'open'});root.innerHTML='<button>Shadow button</button><label>Shadow field <input></label>';root.querySelector('button').onclick=()=>document.getElementById('out').textContent='Shadow clicked';</script>`,
  ),
  "/dialogs": page(
    "Dialogs",
    `<button onclick="alert('Hello there')">Alert</button><button onclick="document.getElementById('out').textContent=confirm('Sure?')?'yes':'no'">Confirm</button><button onclick="document.getElementById('out').textContent=prompt('Name?')">Prompt</button><p id="out"></p>`,
  ),
  "/upload": page(
    "Upload",
    `<label>File <input type="file" id="file" multiple onchange="document.getElementById('out').textContent=[...this.files].map(f=>f.name+':'+f.size).join(',')"></label><button onclick="document.getElementById('file').click()">Choose</button><p id="out"></p>`,
  ),
  "/covered": page(
    "Covered",
    `<button id="target" onclick="this.textContent='clicked'">Under</button><div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>`,
  ),
  "/popup": page(
    "Opener",
    `<a href="/form" target="_blank">Open form</a><button onclick="window.open('/list')">Open list</button>`,
  ),
  "/misc": page(
    "Misc",
    `<h1>Misc</h1><button data-testid="save" onclick="this.textContent='Saved'">Save</button><button>Item</button><button>Item</button><button>Item</button>
<label>Color <select id="color"><option value="r">Red</option><option value="g">Green</option></select></label>
<input placeholder="Search here" id="search"><input type="checkbox" aria-label="Agree" id="agree"><a href="/form" title="Form link">Go to form</a>
<div id="hoverme" onmouseover="this.textContent='hovered'" style="width:100px;height:30px">hover target</div>
<div id="drag" draggable="true" style="width:50px;height:50px;background:red">drag</div><div id="drop" style="width:100px;height:100px;background:#eee" ondragover="event.preventDefault()" ondrop="this.textContent='dropped'">drop here</div>
<p id="late"></p>
<div style="height:2000px"></div><button id="far" onclick="this.textContent='far clicked'">Far away</button>
<script>setTimeout(()=>{document.getElementById('late').textContent='Loaded later'},300);console.log('hello from misc');console.error('misc failed');fetch('/api/data').then(r=>r.json());</script>`,
  ),
  "/errors": page(
    "Errors",
    `<button onclick="null.boom()">Break</button><button onclick="console.error('logged error')">Log</button><button onclick="for (let i = 0; i < 600; i++) console.log('chatter ' + i)">Chatty</button>`,
  ),
  "/zoom": page(
    "Zoom",
    `<div style="height:600px"></div>${Array.from({ length: 12 }, (_, i) => `<button style="margin:4px" onclick="document.getElementById('out').textContent='clicked ${i}'">B${i}</button>`).join("")}<p id="out"></p>`,
  ),
  "/scroll": page(
    "Scroll",
    `<h1>Scroll</h1><div id="pane" style="height:200px;overflow:auto"><div style="height:1000px"></div><p id="deep">Deep in the pane</p></div>
<div style="height:3000px"></div><p id="end">End of the page</p>`,
  ),
  // The page doesn't scroll; a sidebar and the larger main pane do, as in mail and chat apps
  "/app-shell": page(
    "App shell",
    `<style>html,body{margin:0;height:100%;overflow:hidden}body{display:flex}nav{width:150px;overflow:auto}main{flex:1;overflow:auto}</style>
<nav><div style="height:1500px">Sidebar</div></nav><main><div style="height:4000px">Messages</div><p id="last">Last message</p></main>`,
  ),
  // Loads 10 posts at a time as the end comes into view, 40 in all, as feeds do
  "/feed": page(
    "Feed",
    `<h1>Feed</h1><ol id="posts"></ol><p id="sentinel">Loading…</p>
<script>
const topics = ["a sourdough starter", "rewriting it in Rust", "a mechanical keyboard", "my first marathon", "tiny houses", "a lighthouse keeper's notes", "learning the cello", "an old ThinkPad"];
let n = 0;
const more = () => { for (let i = 0; i < 10; i++) { n++; const li = document.createElement("li"); li.style.height = "120px"; li.textContent = "Post " + n + ": " + (n === 37 ? topics[5] : topics[(n * 3) % 8 === 5 ? 0 : (n * 3) % 8]); posts.appendChild(li); } if (n >= 40) { observer.disconnect(); sentinel.textContent = "You're all caught up"; } };
const observer = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) setTimeout(more, 200); });
more();
observer.observe(sentinel);
</script>`,
  ),
  "/big": page(
    "Big",
    Array.from(
      { length: 800 },
      (_, i) =>
        `<p><a href="/p/${i}">Link number ${i}</a> with some text to make it longer</p>`,
    ).join(""),
  ),
};

/** Serves the fixtures; `url(path)` builds absolute URLs */
export async function serveFixtures(): Promise<{
  origin: string;
  url: (path: string) => string;
  close: () => Promise<void>;
  /** Form posts and logins received, newest last */
  posts: Record<string, string>[];
}> {
  const posts: Record<string, string>[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (
      status: number,
      body: string,
      type = "text/html; charset=utf-8",
    ) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const entries: Record<string, string> = {};
        for (const [key, value] of form)
          entries[key] = entries[key] ? `${entries[key]},${value}` : value;
        posts.push(entries);
        if (url.pathname === "/login") {
          if (entries.username === "jane" && entries.password === "hunter2") {
            res.writeHead(303, { location: "/account" });
            res.end();
          } else
            send(
              401,
              page(
                "Sign in",
                `<p role="alert">Wrong username or password</p>`,
              ) + LOGIN,
            );
          return;
        }
        send(
          200,
          page(
            "Order received",
            `<h1>Thanks, order received</h1><pre>${escape(JSON.stringify(entries))}</pre>`,
          ),
        );
      });
      return;
    }
    switch (url.pathname) {
      case "/form":
        return send(200, FORM);
      case "/list":
        return send(200, storyList(STORIES, false));
      case "/newest":
        return send(200, storyList(NEW_STORIES, true));
      case "/repo":
        return send(200, REPO);
      case "/login":
        return send(200, LOGIN);
      case "/account":
        return send(
          200,
          page(
            "Your account",
            `<main><h1>Welcome back, Jane</h1><p>Your plan: Pro. Renews on 2026-12-01.</p><p>Account number: AC-4471-Z</p></main>`,
          ),
        );
      case "/search":
        return send(
          200,
          search(
            url.searchParams.get("q") ?? "",
            Number(url.searchParams.get("page") ?? 1),
          ),
        );
      case "/modal":
        return send(200, MODAL);
      case "/api/data":
        return send(
          200,
          JSON.stringify({ ok: true, items: [1, 2, 3] }),
          "application/json",
        );
      case "/favicon.ico":
        res.writeHead(204);
        return res.end();
      case "/style.css":
        return send(200, "body{}", "text/css");
    }
    if (TESTS[url.pathname]) return send(200, TESTS[url.pathname]);
    if (url.pathname.startsWith("/product/")) {
      const name = decodeURIComponent(url.pathname.slice(9));
      const product = PRODUCTS.find((p) => p.name === name);
      return send(
        product ? 200 : 404,
        page(
          name,
          product
            ? `<h1>${escape(name)}</h1><p>Price: $${product.price}</p><p>SKU: SKU-${PRODUCTS.indexOf(product) + 1000}</p>`
            : "Not found",
        ),
      );
    }
    send(404, page("Not found", `<h1>Not found</h1>`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    posts,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
