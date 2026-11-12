/**
 * The eval's harder fixture pages, which the six easy tasks don't cover: a form whose fields appear as it's answered and whose labels are only nearby text, a payment form in a cross-origin iframe, settings built from nested shadow DOM, a calendar of small targets (the eval opens it at 150% browser zoom), a slow single-page app, and pages that need more than clicks and fills: an autocomplete that listens for key presses, a board whose cards move only by dragging, a `confirm()` dialog, and a page that opens a new tab. Each reports what the user did by posting to `/record`, so a task is checked against what the server received, not the model's word.
 */

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

/** Posts a record as a form body and returns the server's reply ({ ok, ref }) */
const RECORD = `<script>window.record = (fields) => fetch("/record", { method: "POST", body: new URLSearchParams(fields) }).then((r) => r.json());</script>`;

// No <label> and no `for=`: each field's name is only the text beside it, as on many hand-built forms
const SIGNUP = page(
  "Create a workspace",
  `<style>.row{display:flex;gap:8px;margin:6px 0;align-items:center}.lbl{width:140px;color:#555}</style>
<h1>Create a workspace</h1>
<form method="post" action="/post" id="signup"><input type="hidden" name="form" value="signup">
<div class="row"><div class="lbl">Full name</div><input name="fullname"></div>
<div class="row"><div class="lbl">Work email</div><input name="email" type="email"></div>
<div class="row"><div class="lbl">Account type</div><span><input type="radio" name="type" value="personal"> Personal</span><span><input type="radio" name="type" value="business"> Business</span></div>
<div id="business" hidden>
<div class="row"><div class="lbl">Company name</div><input name="company"></div>
<div class="row"><div class="lbl">Company size</div><select name="size"><option value="">Choose…</option><option>1-10</option><option>11-50</option><option>51-200</option><option>201+</option></select></div>
</div>
<div class="row"><div class="lbl">Country</div><select name="country"><option value="">Choose…</option><option>United States</option><option>Canada</option><option>Germany</option></select></div>
<div class="row" id="region" hidden></div>
<section id="team" hidden><h2>Invite your team</h2>
<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody id="members"></tbody></table>
<button type="button" id="add">+ Add row</button></section>
<div class="row"><input type="checkbox" name="terms" id="terms"> <span>I agree to the terms of service</span></div>
<p><button id="create" disabled>Create workspace</button></p></form>
<script>
const form = document.getElementById("signup");
const REGIONS = { "United States": ["State", ["California", "New York", "Texas"]], Canada: ["Province", ["British Columbia", "Ontario", "Quebec"]] };
const addRow = () => {
  const tr = document.createElement("tr");
  tr.innerHTML = '<td><input name="member_name"></td><td><input name="member_email" type="email"></td><td><select name="member_role"><option value="member">Member</option><option value="admin">Admin</option><option value="viewer">Viewer</option></select></td><td><button type="button">Remove</button></td>';
  tr.querySelector("button").onclick = () => tr.remove();
  document.getElementById("members").appendChild(tr);
};
form.addEventListener("change", (event) => {
  const name = event.target.name;
  if (name === "type") {
    const business = form.type.value === "business";
    document.getElementById("business").hidden = !business;
    if (!business) document.getElementById("team").hidden = true;
  }
  if (name === "size") {
    const team = document.getElementById("team");
    team.hidden = !form.size.value || form.size.value === "1-10";
    if (!team.hidden && !document.getElementById("members").children.length) addRow();
  }
  if (name === "country") {
    const row = document.getElementById("region");
    const region = REGIONS[form.country.value];
    row.hidden = !form.country.value;
    row.innerHTML = region
      ? '<div class="lbl">' + region[0] + '</div><select name="region"><option value="">Choose…</option>' + region[1].map((r) => "<option>" + r + "</option>").join("") + "</select>"
      : '<div class="lbl">Postcode</div><input name="region">';
  }
  if (name === "terms") document.getElementById("create").disabled = !form.terms.checked;
});
document.getElementById("add").onclick = addRow;
</script>`,
);

const CHECKOUT = (frameOrigin: string) =>
  page(
    "Checkout",
    `<main><h1>Checkout</h1><p>Desk lamp × 1 — $42.00</p><p>Pay by card below. The payment form is hosted by our payment provider.</p>
<iframe title="Secure payment" src="${frameOrigin}/pay-frame" style="width:420px;height:320px;border:1px solid #ccc"></iframe></main>`,
  );

// Served from another origin than the page that frames it, so Chrome runs it in its own process, as payment providers' frames are
const PAY_FRAME = page(
  "Payment",
  `<form id="pay"><p><label>Name on card <input name="name" autocomplete="cc-name"></label></p>
<p><label>Card number <input name="card" inputmode="numeric" placeholder="1234 1234 1234 1234"></label></p>
<p><label>Expiry <input name="expiry" placeholder="MM / YY"></label> <label>CVC <input name="cvc" inputmode="numeric" maxlength="4"></label></p>
<p><button>Pay $42.00</button></p><p id="out" role="status"></p></form>
<script>
const form = document.getElementById("pay");
// Formats as the user types, as card fields do: groups of four, and "MM / YY"
form.card.addEventListener("input", () => { form.card.value = form.card.value.replace(/\\D/g, "").slice(0, 16).replace(/(\\d{4})(?=\\d)/g, "$1 "); });
form.expiry.addEventListener("input", () => { const d = form.expiry.value.replace(/\\D/g, "").slice(0, 4); form.expiry.value = d.length > 2 ? d.slice(0, 2) + " / " + d.slice(2) : d; });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const out = document.getElementById("out");
  if (form.card.value.replace(/\\D/g, "").length !== 16) { out.textContent = "Card number is incomplete"; return; }
  out.textContent = "Processing…";
  const { ref } = await fetch("/record", { method: "POST", body: new URLSearchParams({ form: "payment", ...Object.fromEntries(new FormData(form)) }) }).then((r) => r.json());
  setTimeout(() => { form.querySelector("button").disabled = true; out.textContent = "Payment approved. Reference " + ref; }, 800);
});
</script>`,
);

// Custom elements, each with its own open shadow root, two levels deep; the switch and the theme menu are ARIA widgets built from divs
const SETTINGS = page(
  "Settings",
  `<h1>Settings</h1><settings-panel></settings-panel>
${RECORD}
<script>
class PrefField extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<p><label>' + this.getAttribute("label") + ' <input></label></p>'; }
  get value() { return this.shadowRoot.querySelector("input").value; }
}
class PrefSwitch extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<style>div[role=switch]{display:inline-block;width:36px;height:20px;border-radius:10px;background:#ccc;cursor:pointer;vertical-align:middle}div[aria-checked=true]{background:#2a7}</style><p><span id="l">' + this.getAttribute("label") + '</span> <div role="switch" tabindex="0" aria-labelledby="l" aria-checked="' + this.hasAttribute("on") + '"></div></p>';
    const sw = root.querySelector("[role=switch]");
    const toggle = () => sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
    sw.addEventListener("click", toggle);
    sw.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
  }
  get value() { return this.shadowRoot.querySelector("[role=switch]").getAttribute("aria-checked") === "true" ? "on" : "off"; }
}
class ThemePicker extends HTMLElement {
  constructor() {
    super();
    this.theme = "Light";
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<p><button aria-haspopup="listbox" aria-expanded="false">Theme: Light</button></p><div role="listbox" aria-label="Theme" hidden>' + ["Light", "Dark", "System"].map((t) => '<div role="option" aria-selected="' + (t === "Light") + '">' + t + "</div>").join("") + "</div>";
    const button = root.querySelector("button");
    const list = root.querySelector("[role=listbox]");
    button.onclick = () => { list.hidden = !list.hidden; button.setAttribute("aria-expanded", String(!list.hidden)); };
    for (const option of list.children) option.onclick = () => {
      this.theme = option.textContent;
      for (const o of list.children) o.setAttribute("aria-selected", String(o === option));
      button.textContent = "Theme: " + this.theme;
      list.hidden = true;
      button.setAttribute("aria-expanded", "false");
    };
  }
  get value() { return this.theme.toLowerCase(); }
}
class SettingsPanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<section><h2>Profile</h2><pref-field label="Display name"></pref-field></section><section><h2>Notifications</h2><pref-switch label="Email notifications"></pref-switch><pref-switch label="Weekly digest" on></pref-switch></section><section><h2>Appearance</h2><theme-picker></theme-picker></section><button id="save">Save changes</button><p role="status" id="status"></p>';
    root.getElementById("save").onclick = async () => {
      const [emails, digest] = root.querySelectorAll("pref-switch");
      await record({ form: "settings", displayName: root.querySelector("pref-field").value, emails: emails.value, digest: digest.value, theme: root.querySelector("theme-picker").value });
      root.getElementById("status").textContent = "Settings saved";
    };
  }
}
customElements.define("pref-field", PrefField);
customElements.define("pref-switch", PrefSwitch);
customElements.define("theme-picker", ThemePicker);
customElements.define("settings-panel", SettingsPanel);
</script>`,
);

// Small, tightly packed day buttons far down the page; the eval opens it at 150% browser zoom, where clicks have missed (BrowserMCP/mcp#207)
const CALENDAR = page(
  "Book a table",
  `<style>.grid{display:grid;grid-template-columns:repeat(7,22px);gap:1px;font-size:11px}.grid button{width:22px;height:18px;padding:0;font-size:10px}.grid button[aria-pressed=true]{background:#2a7;color:white}</style>
<h1>Book a table</h1><p>Pick a day in November, then book.</p><div style="height:700px"></div>
<p><label>Your name <input id="name"></label></p>
<div class="grid" role="group" aria-label="November 2026">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => `<span>${d}</span>`).join("")}<span></span><span></span><span></span><span></span><span></span><span></span>${Array.from({ length: 30 }, (_, i) => `<button data-day="${i + 1}">${i + 1}</button>`).join("")}</div>
<p id="picked">No day picked</p><button id="book">Book</button><p id="out" role="status"></p>
${RECORD}
<script>
const clicks = [];
let day = "";
for (const button of document.querySelectorAll("[data-day]")) button.onclick = () => {
  day = button.dataset.day;
  clicks.push(day);
  for (const b of document.querySelectorAll("[data-day]")) b.setAttribute("aria-pressed", String(b === button));
  document.getElementById("picked").textContent = "Picked: November " + day;
};
document.getElementById("book").onclick = async () => {
  if (!day) { document.getElementById("out").textContent = "Pick a day first"; return; }
  const { ref } = await record({ form: "booking", name: document.getElementById("name").value, day, clicks: clicks.join(" ") });
  document.getElementById("out").textContent = "Booked November " + day + ", confirmation " + ref;
};
</script>`,
);

export const SPA_ORDERS = [
  {
    id: 1041,
    item: "Red kettle",
    total: "$34.00",
    status: "Delivered",
    tracking: "TRK-55120",
  },
  {
    id: 1042,
    item: "Blue lamp",
    total: "$42.00",
    status: "Delivered",
    tracking: "TRK-88213",
  },
  {
    id: 1043,
    item: "Green chair",
    total: "$129.00",
    status: "Shipped",
    tracking: "TRK-90377",
  },
  {
    id: 1044,
    item: "Black mug",
    total: "$12.00",
    status: "Processing",
    tracking: "",
  },
  {
    id: 1045,
    item: "White desk",
    total: "$310.00",
    status: "Delivered",
    tracking: "TRK-10458",
  },
  {
    id: 1046,
    item: "Blue mug",
    total: "$12.00",
    status: "Delivered",
    tracking: "TRK-77341",
  },
];

// Routes with history.pushState (no reloads); every view shows a placeholder, then fetches its data from an API that answers slowly, and the order list re-renders when its statuses refresh
const SPA = page(
  "Acme Shop",
  `<header><a href="/spa" data-link>Acme Shop</a> · <nav aria-label="Main"><a href="/spa/orders" data-link>Your orders</a> · <a href="/spa/account" data-link>Account</a></nav></header><main id="view"></main>
${RECORD}
<script>
const view = document.getElementById("view");
const api = (path) => fetch(path).then((r) => r.json());
let route = 0;
const go = (path) => { history.pushState(null, "", path); render(); };
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (link) { event.preventDefault(); go(link.getAttribute("href")); }
});
addEventListener("popstate", () => render());
const orderList = (orders) => "<h1>Your orders</h1><ul>" + orders.map((o) => '<li><a href="/spa/orders/' + o.id + '" data-link>Order #' + o.id + "</a> — " + o.item + " — " + o.total + " — " + o.status + "</li>").join("") + "</ul>";
async function render() {
  const current = ++route;
  const path = location.pathname;
  const order = /^\\/spa\\/orders\\/(\\d+)$/.exec(path);
  if (path === "/spa/orders") {
    view.innerHTML = "<h1>Your orders</h1><p>Loading your orders…</p>";
    const orders = await api("/api/orders");
    if (current !== route) return;
    view.innerHTML = orderList(orders);
    // A status refresh replaces the list's elements, as polling apps do
    setTimeout(async () => { const fresh = await api("/api/orders"); if (current === route) view.innerHTML = orderList(fresh); }, 2500);
  } else if (order) {
    view.innerHTML = "<h1>Order #" + order[1] + "</h1><p>Tracking number: —</p><p>Loading order…</p>";
    const o = await api("/api/orders/" + order[1]);
    if (current !== route) return;
    view.innerHTML = "<h1>Order #" + o.id + "</h1><p>" + o.item + " — " + o.total + "</p><p>Status: " + o.status + "</p><p>Tracking number: " + (o.tracking || "not shipped yet") + '</p><button id="return">Request a return</button><div id="return-form"></div>';
    document.getElementById("return").onclick = () => {
      document.getElementById("return-form").innerHTML = '<h2>Return</h2><p><label>Reason <select id="reason"><option value="">Choose a reason</option><option value="damaged">Arrived damaged</option><option value="wrong">Wrong item</option><option value="unwanted">No longer needed</option></select></label></p><p><label>Comment <textarea id="comment"></textarea></label></p><button id="submit-return">Submit return</button><p role="status" id="return-status"></p>';
      document.getElementById("submit-return").onclick = async () => {
        const status = document.getElementById("return-status");
        status.textContent = "Submitting…";
        const { ref } = await record({ form: "return", order: o.id, reason: document.getElementById("reason").value, comment: document.getElementById("comment").value });
        setTimeout(() => { status.textContent = "Return requested, reference " + ref; }, 1000);
      };
    };
  } else if (path === "/spa/account") {
    view.innerHTML = "<h1>Account</h1><p>Signed in as Jane.</p>";
  } else {
    view.innerHTML = "<h1>Welcome back, Jane</h1><p>Find your orders under Your orders.</p>";
  }
}
render();
</script>`,
);

/** The run's tag from `?run=`, sent with every record so parallel runs' records stay apart */
const RUN = `<script>window.run = new URLSearchParams(location.search).get("run") ?? "";</script>`;

export const CITIES = [
  { id: "yyz", name: "Toronto, Ontario, Canada" },
  { id: "tor-oh", name: "Toronto, Ohio, United States" },
  { id: "trc", name: "Torrance, California, United States" },
  { id: "trn", name: "Turin, Piedmont, Italy" },
  { id: "tro", name: "Toronto, South Dakota, United States" },
];

// The city field suggests as you type, but listens for key presses only (as many autocomplete widgets do), so setting its value without keystrokes shows no suggestions; the city counts only when picked from the list
const ADDRESS = page(
  "Shipping address",
  `<h1>Shipping address</h1><form id="address">
<p><label>Street <input name="street"></label></p>
<p><label for="city">City</label> <input id="city" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="suggestions" autocomplete="off"></p>
<ul id="suggestions" role="listbox" aria-label="Cities" hidden></ul>
<p><button>Save address</button></p><p id="out" role="status"></p></form>
${RECORD}${RUN}
<script>
const form = document.getElementById("address");
const city = document.getElementById("city");
const list = document.getElementById("suggestions");
let cityId = "";
let timer;
city.addEventListener("input", () => { cityId = ""; });
city.addEventListener("keyup", (event) => {
  if (event.key === "Enter" || event.key === "Tab") return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const query = city.value;
    if (query.length < 2) return;
    const cities = await fetch("/api/cities?q=" + encodeURIComponent(query)).then((r) => r.json());
    if (city.value !== query) return;
    list.innerHTML = cities.map((c) => '<li role="option" data-id="' + c.id + '">' + c.name + "</li>").join("");
    list.hidden = !cities.length;
    city.setAttribute("aria-expanded", String(!list.hidden));
    for (const option of list.children) option.onclick = () => {
      city.value = option.textContent;
      cityId = option.dataset.id;
      list.hidden = true;
      city.setAttribute("aria-expanded", "false");
    };
  }, 300);
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const out = document.getElementById("out");
  if (!cityId) { out.textContent = "Choose a city from the suggestions"; return; }
  await record({ form: "address", run, street: form.street.value, city: cityId });
  out.textContent = "Address saved";
});
</script>`,
);

// Cards move by dragging with the pointer (pointer events, not HTML drag and drop), as in most board apps; there's no menu or keyboard alternative
const BOARD = page(
  "Sprint board",
  `<style>#board{display:flex;gap:16px}.column{width:180px;min-height:220px;background:#f2f2f2;padding:8px}.card{background:white;border:1px solid #ccc;padding:8px;margin:6px 0;cursor:grab;user-select:none;touch-action:none}.card.dragging{opacity:.6;position:fixed;pointer-events:none;width:160px}</style>
<h1>Sprint board</h1><div id="board">${[
    ["To do", ["Write docs", "Fix login bug", "Update logo"]],
    ["In progress", ["Billing page"]],
    ["Done", ["Set up CI"]],
  ]
    .map(
      ([name, cards]) =>
        `<section class="column" aria-label="${name as string}"><h2>${name as string}</h2>${(cards as string[]).map((c) => `<div class="card" role="listitem">${c}</div>`).join("")}</section>`,
    )
    .join("")}</div><p id="out" role="status"></p>
${RECORD}${RUN}
<script>
let dragging = null;
document.addEventListener("pointerdown", (event) => {
  const card = event.target.closest(".card");
  if (!card) return;
  dragging = { card, from: card.parentElement };
  card.classList.add("dragging");
  card.style.left = event.clientX - 20 + "px";
  card.style.top = event.clientY - 10 + "px";
});
document.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  dragging.card.style.left = event.clientX - 20 + "px";
  dragging.card.style.top = event.clientY - 10 + "px";
});
document.addEventListener("pointerup", async (event) => {
  if (!dragging) return;
  const { card, from } = dragging;
  dragging = null;
  card.classList.remove("dragging");
  card.style.left = card.style.top = "";
  const column = document.elementFromPoint(event.clientX, event.clientY)?.closest(".column");
  if (!column || column === from) return;
  column.appendChild(card);
  await record({ form: "board", run, card: card.textContent, column: column.getAttribute("aria-label") });
  document.getElementById("out").textContent = "Moved " + card.textContent + " to " + column.getAttribute("aria-label");
});
</script>`,
);

// Deleting asks with the browser's own confirm(), which blocks the page until it's answered
const PROJECTS = page(
  "Projects",
  `<h1>Projects</h1><ul>${["Marketing site", "Old site", "Mobile app", "Old site backup"].map((p) => `<li><span>${p}</span> <button aria-label="Delete ${p}">Delete</button></li>`).join("")}</ul><p id="out" role="status"></p>
${RECORD}${RUN}
<script>
for (const button of document.querySelectorAll("button")) button.onclick = async () => {
  const name = button.previousElementSibling.textContent;
  if (!confirm('Delete "' + name + '"? This can\\'t be undone.')) { document.getElementById("out").textContent = "Nothing deleted"; return; }
  await record({ form: "delete", run, project: name });
  button.parentElement.remove();
  document.getElementById("out").textContent = "Deleted " + name;
};
</script>`,
);

// The invoice opens in a new tab from a script (no link to follow), with a one-time key the server checks, so the only way to it is the tab the page opens
const BILLING = page(
  "Billing",
  `<h1>Billing</h1><table><thead><tr><th>Invoice</th><th>Month</th><th></th></tr></thead><tbody>${[
    ["INV-2039", "January"],
    ["INV-2040", "February"],
    ["INV-2041", "March"],
    ["INV-2042", "April"],
  ]
    .map(
      ([id, month]) =>
        `<tr><td>${id}</td><td>${month}</td><td><button data-id="${id}">View</button></td></tr>`,
    )
    .join("")}</tbody></table>
<script>
for (const button of document.querySelectorAll("button[data-id]")) button.onclick = async () => {
  const { key } = await fetch("/api/invoice-key", { method: "POST" }).then((r) => r.json());
  window.open("/invoice/" + button.dataset.id + "?key=" + key, "_blank");
};
</script>`,
);

export const INVOICE_AMOUNTS: Record<string, string> = {
  "INV-2039": "$980.00",
  "INV-2040": "$1,105.25",
  "INV-2041": "$1,234.50",
  "INV-2042": "$1,310.75",
};

export const invoicePage = (id: string, amount: string | undefined) =>
  amount
    ? page(
        `Invoice ${id}`,
        `<main><h1>Invoice ${id}</h1><p>Acme Hosting</p><p>Amount due: ${amount}</p><p>Due in 30 days.</p></main>`,
      )
    : page(
        "Link expired",
        `<main><h1>This link has expired</h1><p>Open the invoice from the billing page.</p></main>`,
      );

/** The pages by path; the checkout needs another origin for its frame */
export function hardFixture(
  pathname: string,
  otherOrigin: string,
): string | undefined {
  if (pathname === "/spa" || pathname.startsWith("/spa/")) return SPA;
  switch (pathname) {
    case "/signup":
      return SIGNUP;
    case "/checkout":
      return CHECKOUT(otherOrigin);
    case "/pay-frame":
      return PAY_FRAME;
    case "/settings":
      return SETTINGS;
    case "/calendar":
      return CALENDAR;
    case "/address":
      return ADDRESS;
    case "/board":
      return BOARD;
    case "/projects":
      return PROJECTS;
    case "/billing":
      return BILLING;
  }
}
