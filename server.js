const http = require("http");
const crypto = require("crypto");
const cfg = require("./config");

// Render env vars win over config.js, so the keys can stay out of the repo
const C = Object.assign({}, cfg);
["ADMIN_PATH", "ADMIN_USER", "ADMIN_PASSWORD", "SESSION_SECRET", "PUBLIC_URL", "SUPABASE_URL", "SUPABASE_KEY", "GITHUB_REPO"].forEach(function (k) {
  if (process.env[k]) C[k] = process.env[k];
});
const PORT = process.env.PORT || 10000;
const ABIS = ["universal", "arm64", "armeabi"];

// ---------- supabase (rest) ----------

async function sb(path, opts) {
  opts = opts || {};
  const r = await fetch(C.SUPABASE_URL + "/rest/v1/" + path, {
    method: opts.method || "GET",
    headers: Object.assign({ apikey: C.SUPABASE_KEY, Authorization: "Bearer " + C.SUPABASE_KEY, "Content-Type": "application/json" }, opts.headers || {}),
    body: opts.body
  });
  const text = await r.text();
  if (!r.ok) throw new Error("supabase " + r.status + " " + text.slice(0, 120));
  return text ? JSON.parse(text) : null;   // writes with return=minimal come back empty
}

async function kvGet(key, def) {
  const rows = await sb("kv?key=eq." + encodeURIComponent(key) + "&select=value");
  return rows && rows[0] ? rows[0].value : def;
}

function kvSet(key, value) {
  return sb("kv", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: key, value: value }) });
}

function bump(name, by) {
  return sb("rpc/bump_counter", { method: "POST", body: JSON.stringify({ p_name: name, p_by: by || 1 }) });
}

async function counters() {
  const rows = await sb("counters?select=name,n");
  const m = {};
  (rows || []).forEach(function (r) { m[r.name] = Number(r.n); });
  return m;
}

function setCounter(name, n) {
  return sb("counters", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ name: name, n: n }) });
}

// admin writes go one after another so two clicks can't overwrite each other
let writeChain = Promise.resolve();
function locked(fn) {
  const p = writeChain.then(fn, fn);
  writeChain = p.catch(function () {});
  return p;
}

// small cache + last good copy, the free db can be slow or asleep
const cache = {};
async function cached(key, def, ttl) {
  const c = cache[key];
  if (c && Date.now() - c.t < ttl) return c.v;
  try {
    const v = await kvGet(key, def);
    cache[key] = { v: v, t: Date.now() };
    return v;
  } catch (e) {
    if (c) return c.v;
    throw e;
  }
}
function dropCache() { Object.keys(cache).forEach(function (k) { delete cache[k]; }); }

// ---------- helpers ----------

function releases() { return cached("releases", [], 20000); }
function messages() { return cached("messages", [], 20000); }

function latestOf(list) {
  let best = null;
  list.forEach(function (r) { if (r.active && (!best || r.versionCode > best.versionCode)) best = r; });
  return best;
}

function assetPublic(rel, abi) {
  const a = rel.assets && rel.assets[abi];
  if (!a || !a.url) return null;
  return { url: C.PUBLIC_URL + "/api/download?abi=" + abi + "&v=" + rel.versionCode, size: a.size || 0, sha256: a.sha256 || "" };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
}

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ "Cache-Control": "no-store" }, headers || {}));
  res.end(body);
}

function json(res, data, code) {
  send(res, code || 200, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
}

function clientIp(req) {
  const f = req.headers["x-forwarded-for"];
  return (f ? String(f).split(",")[0].trim() : req.socket.remoteAddress) || "";
}

function readForm(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (d) {
      size += d.length;
      if (size > 200 * 1024) { reject(new Error("too big")); req.destroy(); return; }
      chunks.push(d);
    });
    req.on("end", function () {
      const p = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const o = {};
      p.forEach(function (v, k) { o[k] = v; });
      resolve(o);
    });
    req.on("error", reject);
  });
}

// ---------- public api ----------

const recent = new Map(); // ip+version hash -> time, only to avoid counting the same person twice in an hour

async function handleDownload(req, res, q) {
  const list = await releases();
  let rel = null;
  if (q.get("v")) rel = list.find(function (r) { return r.versionCode === parseInt(q.get("v"), 10) && r.active; });
  if (!rel) rel = latestOf(list);
  if (!rel) return send(res, 404, "no release yet");

  let abi = ABIS.indexOf(q.get("abi")) >= 0 ? q.get("abi") : "universal";
  let a = rel.assets && rel.assets[abi];
  if ((!a || !a.url) && abi !== "universal") { abi = "universal"; a = rel.assets && rel.assets[abi]; }
  if (!a || !a.url) return send(res, 404, "file not available");

  const fromApp = q.get("src") === "app";
  const range = req.headers.range && String(req.headers.range).indexOf("bytes=0-") !== 0;
  if (req.method === "GET" && !range) {
    const key = crypto.createHash("sha1").update(clientIp(req) + "|" + rel.versionCode + "|" + abi + "|" + (fromApp ? "a" : "w")).digest("hex");
    const now = Date.now();
    recent.forEach(function (t, k) { if (t < now - 3600000) recent.delete(k); });
    if (!recent.has(key)) {
      recent.set(key, now);
      // not awaited, the redirect shouldn't wait for the db
      bump(fromApp ? "updates" : "downloads", 1).catch(function () {});
      bump("v:" + rel.versionName, 1).catch(function () {});
    }
  }
  res.writeHead(302, { Location: a.url, "Cache-Control": "no-store" });
  res.end();
}

async function handlePublic(req, res, url) {
  const p = url.pathname.replace(/\.php$/, "");
  const q = url.searchParams;

  if (p === "/api/latest") {
    const rel = latestOf(await releases());
    if (!rel) return json(res, { ok: false, error: "no release yet" }, 404);
    const assets = {};
    ABIS.forEach(function (abi) { const a = assetPublic(rel, abi); if (a) assets[abi] = a; });
    return json(res, {
      ok: true, versionName: rel.versionName, versionCode: rel.versionCode, changelog: rel.changelog,
      publishedAt: rel.publishedAt, mandatory: !!rel.mandatory, assets: assets
    });
  }

  if (p === "/api/stats") {
    const c = await counters();
    return json(res, { downloads: c.downloads || 0, updates: c.updates || 0 });
  }

  if (p === "/api/messages") {
    const after = parseInt(q.get("after") || "0", 10) || 0;
    const now = Date.now();
    const out = (await messages())
      .filter(function (m) { return m.id > after && (!m.expiresAt || m.expiresAt > now); })
      .sort(function (a, b) { return b.id - a.id; })
      .slice(0, 20)
      .map(function (m) { return { id: m.id, title: m.title, body: m.body, type: m.type, link: m.link || "", createdAt: m.createdAt }; });
    return json(res, { ok: true, messages: out });
  }

  if (p === "/api/download") return handleDownload(req, res, q);
  return send(res, 404, "not found");
}

// ---------- admin ----------

const sessions = new Map(); // sid -> {csrf, exp}
const fails = new Map();    // ip -> {n, t}

function cookies(req) {
  const o = {};
  String(req.headers.cookie || "").split(";").forEach(function (c) {
    const i = c.indexOf("=");
    if (i > 0) o[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  });
  return o;
}

function sessionOf(req) {
  const sid = cookies(req).sid;
  const s = sid && sessions.get(sid);
  if (!s || s.exp < Date.now()) return null;
  return s;
}

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function blocked(ip) {
  const f = fails.get(ip);
  return !!f && f.n >= 8 && f.t > Date.now() - 900000;
}

function failed(ip) {
  const f = fails.get(ip);
  fails.set(ip, { n: (f && f.t > Date.now() - 900000 ? f.n : 0) + 1, t: Date.now() });
}

function nextId(list) { return list.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1; }

async function githubLatest() {
  const r = await fetch("https://api.github.com/repos/" + C.GITHUB_REPO + "/releases/latest", {
    headers: { "User-Agent": "SparkyTube-panel", Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error("GitHub said " + r.status);
  const j = await r.json();
  const assets = {};
  (j.assets || []).forEach(function (a) {
    const n = a.name.toLowerCase();
    if (!n.endsWith(".apk")) return;
    const abi = n.indexOf("universal") >= 0 ? "universal" : n.indexOf("arm64") >= 0 ? "arm64" : (n.indexOf("armeabi") >= 0 || n.indexOf("v7a") >= 0) ? "armeabi" : "";
    if (!abi) return;
    assets[abi] = { url: a.browser_download_url, size: a.size || 0, sha256: a.digest && a.digest.indexOf("sha256:") === 0 ? a.digest.slice(7) : "" };
  });
  return { tag: String(j.tag_name || "").replace(/^[vV]/, ""), body: String(j.body || "").trim(), assets: assets };
}

async function probeSize(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(6000) });
    return Number(r.headers.get("content-length")) || 0;
  } catch (e) { return 0; }
}

async function adminAction(act, f) {
  if (act === "publish") {
    const name = (f.versionName || "").trim(), code = parseInt(f.versionCode, 10);
    if (!name || !(code > 0)) return [false, "Version name and a version code are needed."];
    const assets = {};
    for (const abi of ABIS) {
      const url = (f["url_" + abi] || "").trim();
      if (!url) continue;
      if (!/^https:\/\//i.test(url)) return [false, abi + ": link must start with https://"];
      assets[abi] = { url: url, size: await probeSize(url), sha256: (f["sha_" + abi] || "").trim() };
    }
    if (!assets.universal) return [false, "The universal apk link is required, the in-app updater uses it."];
    return locked(async function () {
      const list = await kvGet("releases", []);
      if (list.some(function (r) { return r.versionCode === code; })) return [false, "That version code already exists."];
      list.push({ id: nextId(list), versionName: name, versionCode: code, changelog: (f.changelog || "").trim(), publishedAt: new Date().toISOString(), mandatory: !!f.mandatory, active: true, assets: assets });
      await kvSet("releases", list);
      if (f.announce) {
        const m = await kvGet("messages", []);
        m.push({ id: nextId(m), title: "SparkyTube " + name + " is out", body: "Open Settings > Update to download it.", type: "update", link: "", createdAt: new Date().toISOString(), expiresAt: 0 });
        await kvSet("messages", m);
      }
      dropCache();
      return [true, "Published " + name + "."];
    });
  }

  if (act === "import_github") {
    const code = parseInt(f.versionCode, 10);
    if (!(code > 0)) return [false, "Version code is needed."];
    let g;
    try { g = await githubLatest(); } catch (e) { return [false, "Couldn't read the GitHub release: " + e.message]; }
    if (!g.assets.universal) return [false, "No universal apk found in the latest GitHub release."];
    return locked(async function () {
      const list = await kvGet("releases", []);
      if (list.some(function (r) { return r.versionCode === code; })) return [false, "That version code already exists."];
      list.push({ id: nextId(list), versionName: g.tag, versionCode: code, changelog: g.body, publishedAt: new Date().toISOString(), mandatory: false, active: true, assets: g.assets });
      await kvSet("releases", list);
      dropCache();
      return [true, "Imported " + g.tag + " from GitHub."];
    });
  }

  if (act === "toggle_release" || act === "delete_release") {
    const id = parseInt(f.id, 10);
    return locked(async function () {
      let list = await kvGet("releases", []);
      list = act === "delete_release"
        ? list.filter(function (r) { return r.id !== id; })
        : list.map(function (r) { if (r.id === id) r.active = !r.active; return r; });
      await kvSet("releases", list);
      dropCache();
      return [true, "Done."];
    });
  }

  if (act === "message") {
    const title = (f.title || "").trim(), body = (f.body || "").trim();
    if (!title || !body) return [false, "Title and message are needed."];
    const type = ["info", "update", "warning"].indexOf(f.type) >= 0 ? f.type : "info";
    const link = (f.link || "").trim();
    if (link && !/^https?:\/\//i.test(link)) return [false, "Link must start with http(s)://"];
    const days = parseInt(f.days, 10) || 0;
    return locked(async function () {
      const m = await kvGet("messages", []);
      m.push({ id: nextId(m), title: title, body: body, type: type, link: link, createdAt: new Date().toISOString(), expiresAt: days > 0 ? Date.now() + days * 86400000 : 0 });
      await kvSet("messages", m);
      dropCache();
      return [true, "Message sent. Apps pick it up on their next check."];
    });
  }

  if (act === "delete_message") {
    const id = parseInt(f.id, 10);
    return locked(async function () {
      const m = (await kvGet("messages", [])).filter(function (x) { return x.id !== id; });
      await kvSet("messages", m);
      dropCache();
      return [true, "Message removed."];
    });
  }

  if (act === "set_downloads") {
    const n = Math.max(0, parseInt(f.downloads, 10) || 0);
    await setCounter("downloads", n);
    return [true, "Download count set."];
  }
  return [false, "Unknown action."];
}

const CSS = ":root{--bg:#0f0f11;--card:#1a1a1d;--line:#2a2a2f;--tx:#ececef;--mut:#8d8d95;--red:#ef4a4a}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 system-ui,sans-serif}.wrap{max-width:820px;margin:0 auto;padding:16px}h1{font-size:21px;margin:6px 0 14px}h2{font-size:16px;margin:0 0 10px}.card{background:var(--card);border-radius:14px;padding:16px;margin-bottom:12px}label{display:block;font-size:12px;color:var(--mut);margin:10px 0 4px}input,textarea,select{width:100%;background:#232327;color:var(--tx);border:0;border-radius:9px;padding:10px;font:inherit}textarea{min-height:100px;resize:vertical}button{background:var(--red);color:#fff;border:0;border-radius:9px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer}button.g{background:#2f2f35}button.d{background:#7a2323}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:140px}.flash{padding:11px 14px;border-radius:10px;margin-bottom:12px}.ok{background:#14301f}.bad{background:#3a1717}.tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}.tabs a{padding:7px 14px;border-radius:99px;background:var(--card);color:var(--mut);text-decoration:none}.tabs a.on{background:var(--red);color:#fff}.pane{display:none}.pane.on{display:block}.item{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)}.item:first-of-type{border-top:0}.mut{color:var(--mut);font-size:13px}.num{font-size:32px;font-weight:700}.chip{font-size:11px;padding:2px 8px;border-radius:99px;background:#2f2f35;color:var(--mut)}form.i{display:inline}";

function form(csrf, act, inner, extra) {
  return '<form method="post"' + (extra || "") + '><input type="hidden" name="action" value="' + act + '"><input type="hidden" name="csrf" value="' + csrf + '">' + inner + "</form>";
}

async function panelPage(sess, flash) {
  const csrf = sess.csrf;
  const rels = (await kvGet("releases", [])).sort(function (a, b) { return b.versionCode - a.versionCode; });
  const msgs = (await kvGet("messages", [])).sort(function (a, b) { return b.id - a.id; });
  const stats = await counters();
  const latest = latestOf(rels);
  const nextCode = latest ? latest.versionCode + 1 : 1;
  const byVer = Object.keys(stats).filter(function (k) { return k.indexOf("v:") === 0; }).map(function (k) { return esc(k.slice(2)) + ": " + stats[k]; }).join(" &nbsp; ");

  const abiInputs = [["universal", "Universal (required)"], ["arm64", "arm64-v8a"], ["armeabi", "armeabi-v7a"]].map(function (x) {
    return '<label>' + x[1] + ' : https link</label><div class="row"><input name="url_' + x[0] + '" placeholder="https://github.com/.../app.apk"><input name="sha_' + x[0] + '" placeholder="sha256 (optional)"></div>';
  }).join("");

  const relRows = rels.length ? rels.map(function (r) {
    return '<div class="item"><div><b>v' + esc(r.versionName) + '</b> <span class="chip">code ' + r.versionCode + '</span> ' + (r.active ? "" : '<span class="chip">hidden</span> ') + (latest && latest.id === r.id ? '<span class="chip" style="color:#58c27d">live</span>' : "") +
      '<div class="mut">' + esc(String(r.publishedAt).slice(0, 10)) + " · " + esc(Object.keys(r.assets).join(", ")) + "</div></div><div>" +
      form(csrf, "toggle_release", '<input type="hidden" name="id" value="' + r.id + '"><button class="g">' + (r.active ? "Hide" : "Show") + "</button>", ' class="i"') + " " +
      form(csrf, "delete_release", '<input type="hidden" name="id" value="' + r.id + '"><button class="d">Delete</button>', ' class="i" onsubmit="return confirm(\'Delete this release?\')"') + "</div></div>";
  }).join("") : '<p class="mut">Nothing published yet.</p>';

  const msgRows = msgs.length ? msgs.map(function (m) {
    return '<div class="item"><div><b>' + esc(m.title) + '</b> <span class="chip">' + esc(m.type) + '</span><div class="mut">' + esc(m.body) + '</div><div class="mut">' + esc(String(m.createdAt).slice(0, 10)) + "</div></div>" +
      form(csrf, "delete_message", '<input type="hidden" name="id" value="' + m.id + '"><button class="d">Remove</button>', ' class="i"') + "</div>";
  }).join("") : '<p class="mut">No messages yet.</p>';

  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>SparkyTube admin</title><style>' + CSS + '</style></head><body><div class="wrap">' +
    (flash ? '<div class="flash ' + (flash[0] ? "ok" : "bad") + '">' + esc(flash[1]) + "</div>" : "") +
    '<div class="row" style="align-items:center"><h1>SparkyTube admin</h1>' + form(csrf, "logout", '<button class="g">Log out</button>', ' style="flex:0"') + "</div>" +
    '<div class="tabs" id="tabs"><a href="#releases">Releases</a><a href="#broadcast">Broadcast</a><a href="#stats">Stats</a></div>' +

    '<div class="pane" id="p-releases"><div class="card"><h2>Publish a release</h2>' +
    form(csrf, "publish",
      '<div class="row"><div><label>Version name (e.g. 2.1)</label><input name="versionName" required></div><div><label>Version code (must go up)</label><input name="versionCode" type="number" value="' + nextCode + '" required></div></div>' +
      '<label>Changelog</label><textarea name="changelog" placeholder="What\'s new..."></textarea>' + abiInputs +
      '<label><input type="checkbox" name="mandatory" style="width:auto"> Mark as important</label>' +
      '<label><input type="checkbox" name="announce" style="width:auto" checked> Also send an "update is out" message</label><p><button>Publish</button></p>') + "</div>" +
    '<div class="card"><h2>Import from GitHub</h2><p class="mut">Takes the latest GitHub release (tag, notes and apk links).</p>' +
    form(csrf, "import_github", '<div class="row"><input name="versionCode" type="number" value="' + nextCode + '" required><button>Import latest</button></div>') + "</div>" +
    '<div class="card"><h2>Releases</h2>' + relRows + "</div></div>" +

    '<div class="pane" id="p-broadcast"><div class="card"><h2>Send a message to all users</h2>' +
    form(csrf, "message",
      '<label>Title</label><input name="title" maxlength="80" required><label>Message</label><textarea name="body" required></textarea>' +
      '<div class="row"><div><label>Type</label><select name="type"><option value="info">Info</option><option value="update">Update</option><option value="warning">Warning</option></select></div><div><label>Disappears after (days, 0 = never)</label><input name="days" type="number" value="0"></div></div>' +
      '<label>Link (optional)</label><input name="link" placeholder="https://..."><p><button>Send</button></p>') +
    '<p class="mut">Users get a notification and see it in Settings > Update > Messages.</p></div><div class="card"><h2>Sent</h2>' + msgRows + "</div></div>" +

    '<div class="pane" id="p-stats"><div class="card"><h2>Downloads</h2><div class="num">' + (stats.downloads || 0).toLocaleString("en-US") + '</div><div class="mut">from the website · ' + (stats.updates || 0).toLocaleString("en-US") + " in-app updates</div>" + (byVer ? '<p class="mut">' + byVer + "</p>" : "") + "</div>" +
    '<div class="card"><h2>Set the counter</h2><p class="mut">Use this once to start from your old total.</p>' +
    form(csrf, "set_downloads", '<div class="row"><input name="downloads" type="number" min="0" value="' + (stats.downloads || 0) + '"><button>Save</button></div>') + "</div></div>" +

    '<script>var tabs=[].slice.call(document.querySelectorAll("#tabs a"));function show(){var h=(location.hash||"#releases").slice(1);if(!document.getElementById("p-"+h))h="releases";tabs.forEach(function(a){a.className=a.getAttribute("href")==="#"+h?"on":""});[].slice.call(document.querySelectorAll(".pane")).forEach(function(p){p.className="pane"+(p.id==="p-"+h?" on":"")})}addEventListener("hashchange",show);show();</script></div></body></html>';
}

function loginPage(flash) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in</title><style>' + CSS + '</style></head><body><div class="wrap">' +
    (flash ? '<div class="flash ' + (flash[0] ? "ok" : "bad") + '">' + esc(flash[1]) + "</div>" : "") +
    '<h1>SparkyTube admin</h1><div class="card"><form method="post"><input type="hidden" name="action" value="login"><label>Username</label><input name="user" autocomplete="username" required><label>Password</label><input name="pass" type="password" autocomplete="current-password" required><p><button>Log in</button></p></form></div></div></body></html>';
}

async function handleAdmin(req, res) {
  const ip = clientIp(req);
  const htmlHead = { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };
  let flash = null;

  if (req.method === "POST") {
    let f;
    try { f = await readForm(req); } catch (e) { return send(res, 400, "bad request"); }
    const act = f.action || "";

    if (act === "login") {
      if (C.ADMIN_PASSWORD === "CHANGE_ME_NOW") flash = [false, "Set ADMIN_PASSWORD in config.js first."];
      else if (blocked(ip)) flash = [false, "Too many tries, wait 15 minutes."];
      else if (same(C.ADMIN_USER, f.user || "") && same(C.ADMIN_PASSWORD, f.pass || "")) {
        const sid = crypto.randomBytes(24).toString("hex");
        sessions.set(sid, { csrf: crypto.randomBytes(16).toString("hex"), exp: Date.now() + 8 * 3600000 });
        return send(res, 303, "", { Location: C.ADMIN_PATH, "Set-Cookie": "sid=" + sid + "; HttpOnly; Secure; SameSite=Strict; Path=" + C.ADMIN_PATH + "; Max-Age=28800" });
      } else {
        failed(ip);
        await new Promise(function (r) { setTimeout(r, 900); });
        flash = [false, "Wrong username or password."];
      }
      return send(res, 200, loginPage(flash), htmlHead);
    }

    const sess = sessionOf(req);
    if (!sess) return send(res, 200, loginPage([false, "Login first."]), htmlHead);
    if (!same(sess.csrf, f.csrf || "")) flash = [false, "Bad form token, reload the page."];
    else if (act === "logout") {
      sessions.delete(cookies(req).sid);
      return send(res, 303, "", { Location: C.ADMIN_PATH, "Set-Cookie": "sid=; Max-Age=0; Path=" + C.ADMIN_PATH });
    } else {
      try { flash = await adminAction(act, f); } catch (e) { flash = [false, "Failed: " + e.message]; }
    }
    return send(res, 200, await panelPage(sess, flash), htmlHead);
  }

  const sess = sessionOf(req);
  if (!sess) return send(res, 200, loginPage(null), htmlHead);
  try { return send(res, 200, await panelPage(sess, null), htmlHead); }
  catch (e) { return send(res, 500, "Database error: " + esc(e.message), htmlHead); }
}

// ---------- server ----------

const server = http.createServer(async function (req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") return send(res, 204, "", { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" });
    if (url.pathname === "/health") return send(res, 200, "ok");
    if (url.pathname === "/") return send(res, 200, "SparkyTube API");
    if (url.pathname === C.ADMIN_PATH) return await handleAdmin(req, res);
    if (url.pathname.indexOf("/api/") === 0) return await handlePublic(req, res, url);
    return send(res, 404, "not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, { ok: false, error: "server error" }, 500);
  }
});

server.listen(PORT, function () { console.log("SparkyTube server on " + PORT); });
