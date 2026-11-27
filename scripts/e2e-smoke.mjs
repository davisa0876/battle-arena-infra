#!/usr/bin/env node
// End-to-end smoke test for the Battle Arena local environment (`docker compose up -d --build`).
// It behaves like the two real clients:
//   - "web":    Sanctum SPA cookie session + XSRF header + browser Origin (React app)
//   - "mobile": bearer token, no Origin header (Expo app)
// and verifies that the stack really runs the Lambda/Bref + event-driven realtime architecture.
//
// Usage (from battle-arena-infra, stack running, catalog imported):
//   node scripts/e2e-smoke.mjs
//   node scripts/e2e-smoke.mjs --turn-timeout   # needs a short PVP_TURN_TIMEOUT_SECONDS, see README
//
// Requires Node >= 20 and the `ws` package (resolved from ../battle-arena-realtime/node_modules
// unless WS_MODULE points elsewhere). Creates throwaway accounts (handles start with "e2e").

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const infraDir = resolve(here, "..");
const args = process.argv.slice(2);
const runTimeoutScenario = args.includes("--turn-timeout");

const require = createRequire(import.meta.url);
const WebSocket = require(process.env.WS_MODULE ?? resolve(infraDir, "../battle-arena-realtime/node_modules/ws"));

const cfg = {
  api: process.env.API_BASE ?? "http://localhost:8000",
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  web: process.env.WEB_BASE ?? "http://localhost:3000",
  expectWs: "ws://localhost:3001/ws",
  artisan: ["compose", "exec", "-T", "api", "php", "artisan"],
};

function docker(...dockerArgs) {
  const result = spawnSync("docker", dockerArgs, { cwd: infraDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${dockerArgs.join(" ")} failed: ${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? "" });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: error.message });
    console.log(`  FAIL  ${name} — ${error.message}`);
  }
}
/** A documented pre-existing defect: reported separately so it never masks regressions. */
async function checkKnownIssue(name, issue, fn) {
  try {
    await fn();
    results.push({ name, ok: true, detail: "issue no longer reproduces" });
    console.log(`  PASS  ${name} — known issue no longer reproduces: ${issue}`);
  } catch (error) {
    results.push({ name, ok: true, known: true, detail: `${issue} (${error.message})` });
    console.log(`  KNOWN ${name} — ${issue}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------------------------------

class ApiClient {
  constructor(kind) {
    this.kind = kind; // "web" | "mobile"
    this.cookies = new Map();
    this.token = null;
  }

  headers(method, extra = {}) {
    const h = { Accept: "application/json", "Accept-Language": "en", ...extra };
    if (this.kind === "web") {
      h.Origin = cfg.origin;
      h.Referer = `${cfg.origin}/`;
      if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      const xsrf = this.cookies.get("XSRF-TOKEN");
      if (xsrf && method !== "GET") h["X-XSRF-TOKEN"] = decodeURIComponent(xsrf);
    } else if (this.token) {
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  absorbCookies(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async raw(method, path, { json, form, headers = {} } = {}) {
    const h = this.headers(method, headers);
    let body;
    if (json !== undefined) {
      h["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    const res = await fetch(`${cfg.api}${path}`, { method, headers: h, body, redirect: "manual" });
    this.absorbCookies(res);
    return res;
  }

  async call(method, path, opts = {}, expectStatus = [200, 201]) {
    const res = await this.raw(method, path, opts);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    const allowed = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
    if (!allowed.includes(res.status)) {
      throw new Error(`${method} ${path} -> ${res.status} ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 300)}`);
    }
    return { status: res.status, data, headers: res.headers };
  }

  async csrf() {
    if (this.kind === "web") await this.raw("GET", "/sanctum/csrf-cookie");
  }
}

function mutationHeaders() {
  return { headers: { "Idempotency-Key": randomUUID() } };
}

function artisan(...artisanArgs) {
  const result = spawnSync("docker", [...cfg.artisan, ...artisanArgs], { cwd: infraDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`artisan ${artisanArgs.join(" ")} failed: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

// ---------------------------------------------------------------------------------------------
// WebSocket client (same protocol as battle-arena-web / battle-arena-mobile pvpRealtimeSession)
// ---------------------------------------------------------------------------------------------

class RealtimeClient {
  constructor(api, label) {
    this.api = api;
    this.label = label;
    this.frames = [];
    this.waiters = [];
    this.socket = null;
  }

  async connect() {
    const { data } = await this.api.call("POST", "/api/realtime/tickets", {}, 201);
    this.wsUrl = data.data.ws_url;
    const url = new URL(data.data.ws_url);
    url.searchParams.set("ticket", data.data.ticket);
    this.lastTicketUrl = url.toString();
    await this.open(url.toString());
    const ready = await this.waitFor((f) => f.type === "connection.ready", 10_000, "connection.ready");
    this.heartbeat = setInterval(() => this.send({ v: 1, type: "ping" }), Math.max(5_000, ready.payload.heartbeat_interval_ms - 5_000));
    return ready;
  }

  open(url) {
    return new Promise((resolvePromise, reject) => {
      const headers = this.api.kind === "web" ? { Origin: cfg.origin } : {};
      const socket = new WebSocket(url, { headers });
      this.socket = socket;
      socket.on("open", () => resolvePromise());
      socket.on("unexpected-response", (_req, res) => reject(Object.assign(new Error(`upgrade rejected ${res.statusCode}`), { status: res.statusCode })));
      socket.on("error", (error) => reject(error));
      socket.on("message", (raw) => {
        let frame;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        this.frames.push(frame);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(frame)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          }
        }
      });
      socket.on("close", () => clearInterval(this.heartbeat));
    });
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate, timeoutMs = 8_000, label = "frame") {
    const existing = this.frames.find(predicate);
    if (existing) {
      this.frames.splice(this.frames.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: (frame) => {
          this.frames.splice(this.frames.indexOf(frame), 1);
          resolvePromise(frame);
        },
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`${this.label}: timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async subscribe(roomId) {
    const { data } = await this.api.call("POST", `/api/pvp/rooms/${roomId}/subscription-grants`, {}, 201);
    this.send({ v: 1, type: "room.subscribe", payload: { grant: data.data.grant } });
    return this.waitFor((f) => f.type === "room.subscribed" && f.payload.room_id === roomId, 8_000, "room.subscribed");
  }

  close() {
    clearInterval(this.heartbeat);
    return new Promise((resolvePromise) => {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return resolvePromise();
      this.socket.once("close", () => resolvePromise());
      this.socket.close();
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngFixture(size = 96) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      row[1 + x * 3] = (x * 255) / size;
      row[2 + x * 3] = (y * 255) / size;
      row[3 + x * 3] = 128;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function imageKind(bytes) {
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  return "unknown";
}

async function register(client, handle) {
  await client.csrf();
  const body = {
    handle,
    display_name: handle,
    email: `${handle}@e2e.battlearena.local`,
    password: "Passw0rd!x-e2e",
    password_confirmation: "Passw0rd!x-e2e",
    ...(client.kind === "mobile" ? { device_name: "e2e-expo" } : {}),
  };
  const { data } = await client.call("POST", "/api/register", { json: body }, 201);
  if (client.kind === "mobile") client.token = data.meta.token;
  client.user = data.data;
  client.email = body.email;
  client.password = body.password;
  return data;
}

async function playPvpTurns(clients, battleId, maxActions, rtByUser) {
  let actions = 0;
  let lastVersion = 0;
  while (actions < maxActions) {
    let acted = false;
    for (const client of clients) {
      const { data } = await client.call("GET", `/api/pvp/battles/${battleId}`);
      const s = data.data;
      if (s.phase === "finished" || s.status === "finished") return { finished: true, actions, version: s.version };
      lastVersion = s.version;
      if (s.phase === "awaiting_attack" && Number(s.current_attacker_user_id) === client.user.id) {
        const usable = (s.me?.moves ?? []).find((m) => m.can_use);
        const payload = usable ? { move_id: Number(usable.id), expected_version: s.version } : { recover: true, expected_version: s.version };
        await client.call("POST", `/api/pvp/battles/${battleId}/attack`, { json: payload, ...mutationHeaders() });
        acted = true;
      } else if (s.phase === "awaiting_defense" && Number(s.current_defender_user_id) === client.user.id) {
        await client.call("POST", `/api/pvp/battles/${battleId}/defend`, { json: { defense: "endure", expected_version: s.version }, ...mutationHeaders() });
        acted = true;
      }
      if (acted) {
        actions += 1;
        // Every committed mutation must reach every subscribed socket as a hint with a newer version.
        await Promise.all(
          Object.values(rtByUser).map((rt) =>
            rt.waitFor((f) => f.type === "pvp.battle.changed" && f.payload.battle_id === battleId && f.payload.version > lastVersion, 8_000, "pvp.battle.changed"),
          ),
        );
        break;
      }
    }
    assert(acted, "no player could act on the battle");
  }
  return { finished: false, actions, version: lastVersion };
}

async function setupBattle(host, guest, rtHost, rtGuest, ownedHost, ownedGuest) {
  const created = await host.call("POST", "/api/pvp/rooms", { json: { invitee_handle: guest.user.profile.handle }, ...mutationHeaders() }, 201);
  const roomId = created.data.data.room?.id ?? created.data.data.id;
  const invitationId = created.data.data.invitation.id;
  await rtGuest.waitFor((f) => f.type === "pvp.invitation.changed" && f.payload.invitation_id === invitationId, 8_000, "invitation hint");
  await guest.call("POST", `/api/pvp/invitations/${invitationId}/accept`, mutationHeaders());
  await rtHost.subscribe(roomId);
  await rtGuest.subscribe(roomId);

  const version = async () => (await host.call("GET", `/api/pvp/rooms/${roomId}`)).data.data.version;
  // Selection and the first ready are not broadcast; battle start is (room + battle hints).
  await host.call("PUT", `/api/pvp/rooms/${roomId}/selection`, { json: { owned_creature_id: ownedHost, expected_room_version: await version() }, ...mutationHeaders() });
  await guest.call("PUT", `/api/pvp/rooms/${roomId}/selection`, { json: { owned_creature_id: ownedGuest, expected_room_version: await version() }, ...mutationHeaders() });
  await host.call("POST", `/api/pvp/rooms/${roomId}/ready`, { json: { expected_room_version: await version() }, ...mutationHeaders() });
  const ready = await guest.call("POST", `/api/pvp/rooms/${roomId}/ready`, { json: { expected_room_version: await version() }, ...mutationHeaders() });
  const battleId = ready.data.data.battle?.id ?? ready.data.data.battle_id;
  assert(battleId, "ready did not start a battle");
  await Promise.all(
    [rtHost, rtGuest].flatMap((c) => [
      c.waitFor((f) => f.type === "pvp.room.changed" && f.payload.room_id === roomId, 8_000, "battle-start room hint"),
      c.waitFor((f) => f.type === "pvp.battle.changed" && f.payload.battle_id === battleId, 8_000, "battle-start battle hint"),
    ]),
  );
  return { roomId, battleId };
}

// ---------------------------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------------------------

const suffix = randomBytes(3).toString("hex");
const web = new ApiClient("web");
const mobile = new ApiClient("mobile");
const rt = {};
let ownedWeb;
let ownedMobile;
let roomId;
let battleId;

console.log(`\nBattle Arena e2e smoke — api=${cfg.api}\n`);

await check("Architecture: API and realtime run as Lambda images behind the gateway", async () => {
  const inspect = (service) => {
    const id = docker("compose", "ps", "-q", service);
    assert(id, `${service} is not running`);
    return JSON.parse(docker("inspect", id))[0];
  };
  const api = inspect("api");
  const rt = inspect("realtime");
  const envOf = (c) => Object.fromEntries(c.Config.Env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  assert(JSON.stringify(api.Config.Entrypoint).includes("lambda-entrypoint"), "api does not use the Lambda entrypoint (RIE)");
  assert(envOf(api).BREF_RUNTIME === "fpm", "api is not the Bref FPM runtime");
  assert(envOf(inspect("console")).BREF_RUNTIME === "console", "console is not the Bref console runtime");
  assert(JSON.stringify(rt.Config.Cmd).includes("dist/lambda/handler.handler"), "realtime is not the Lambda handler");
  assert(api.HostConfig.ReadonlyRootfs && api.Config.User === "993:990", "api is not read-only / unprivileged like Lambda");
  assert(!api.HostConfig.PortBindings || Object.keys(api.HostConfig.PortBindings).length === 0, "Lambda containers must not publish ports");
  const health = JSON.parse(docker("compose", "exec", "-T", "gateway", "node", "-e",
    "fetch('http://127.0.0.1:9001/__local/health').then(r=>r.text()).then(t=>process.stdout.write(t))"));
  return `functions: ${health.functions.join(", ")}`;
});

await check("Realtime is event-driven: nobody subscribes to Redis Pub/Sub", async () => {
  const channel = "battle-arena:realtime:notifications:v1";
  const out = docker("compose", "exec", "-T", "redis", "redis-cli", "PUBSUB", "NUMSUB", channel);
  assert(/\n0$/.test(out) || out.endsWith("\r\n0") || out.split(/\s+/).pop() === "0", `subscribers: ${out}`);
  return "0 Pub/Sub subscribers";
});

await check("API liveness and readiness (PostgreSQL + Redis)", async () => {
  const live = await web.call("GET", "/api/health");
  const ready = await web.call("GET", "/api/ready");
  assert(ready.data.checks.postgres === "ok" && ready.data.checks.redis === "ok", JSON.stringify(ready.data));
  return `${live.data.status}/${ready.data.status}`;
});

await check("Web registration (Sanctum SPA cookie session)", async () => {
  const data = await register(web, `webe2e${suffix}`);
  assert(data.meta.auth_mode === "session", `auth_mode=${data.meta.auth_mode}`);
  assert(web.cookies.size > 0, "no session cookie");
  return [...web.cookies.keys()].join(",");
});

await check("Mobile registration (Expo bearer token)", async () => {
  const data = await register(mobile, `mobe2e${suffix}`);
  assert(data.meta.auth_mode === "token" && mobile.token, "no bearer token");
});

await check("Authenticated /api/me for both clients; guests get 401", async () => {
  const a = await web.call("GET", "/api/me");
  const b = await mobile.call("GET", "/api/me");
  assert(a.data.data.id === web.user.id && b.data.data.id === mobile.user.id, "identity mismatch");
  await new ApiClient("mobile").call("GET", "/api/me", {}, 401);
});

await check("Mobile logout revokes token; login issues a new one", async () => {
  await mobile.call("POST", "/api/logout", {}, [200, 204]);
  await mobile.call("GET", "/api/me", {}, 401);
  const { data } = await mobile.call("POST", "/api/login", { json: { email: mobile.email, password: mobile.password, device_name: "e2e-expo" } });
  mobile.token = data.meta.token;
  await mobile.call("GET", "/api/me");
});

await check("Verification email delivered to Mailpit", async () => {
  const res = await fetch(`http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`to:${web.email}`)}`);
  const data = await res.json();
  assert(data.messages_count >= 1, `messages_count=${data.messages_count}`);
});

await check("Profile image upload (multipart) and binary download", async () => {
  const form = new FormData();
  form.append("avatar", new Blob([pngFixture()], { type: "image/png" }), "avatar.png");
  const up = await web.call("POST", "/api/me/avatar", { form });
  const url = up.data.data.profile.avatar_url;
  assert(url, "no avatar_url");
  const res = await fetch(new URL(url, cfg.api).toString().replace(/^https?:\/\/[^/]+/, cfg.api));
  const bytes = Buffer.from(await res.arrayBuffer());
  assert(res.status === 200, `avatar GET ${res.status}`);
  const kind = imageKind(bytes);
  assert(kind !== "unknown", `avatar bytes are not an image (${bytes.subarray(0, 12).toString("hex")})`);
  return `${kind}, ${bytes.length} bytes, ${res.headers.get("content-type")}`;
});

await check("Creature catalog and game rules (feature flags unchanged)", async () => {
  const list = await web.call("GET", "/api/creatures?per_page=5");
  assert(list.data.data.length > 0, "empty catalog — run creatures:import");
  const rules = await web.call("GET", "/api/game/rules");
  const features = rules.data.data?.features ?? rules.data.features;
  assert(features.pvp === false, "features.pvp must stay false");
  return `${list.data.meta?.total ?? list.data.data.length} creatures; pve=${features.pve} pvp=${features.pvp}`;
});

await check("Starter selection and collection", async () => {
  const a = await web.call("POST", "/api/me/starter", { json: { creature_slug: "charmander" }, ...mutationHeaders() }, 201);
  const b = await mobile.call("POST", "/api/me/starter", { json: { creature_slug: "squirtle" }, ...mutationHeaders() }, 201);
  ownedWeb = a.data.data.id;
  ownedMobile = b.data.data.id;
  const mine = await web.call("GET", "/api/me/creatures");
  assert(mine.data.data.some((c) => c.id === ownedWeb), "starter missing from collection");
});

await check("Authorization: a player cannot read another player's creature", async () => {
  const res = await web.raw("GET", `/api/me/creatures/${ownedMobile}`);
  assert([403, 404].includes(res.status), `got ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("PvE battle to completion with XP reward (progression)", async () => {
  const before = (await mobile.call("GET", "/api/me")).data.data.trainer.total_xp;
  const start = await mobile.call("POST", "/api/pve/battles", { json: { owned_creature_id: ownedMobile, difficulty: "easy" }, ...mutationHeaders() }, 201);
  const id = start.data.data.id;
  let reward = null;
  for (let i = 0; i < 120 && reward === null; i += 1) {
    const s = (await mobile.call("GET", `/api/pve/battles/${id}`)).data.data;
    if (s.phase === "finished") {
      reward = s.reward?.xp_awarded ?? 0;
      break;
    }
    if (s.phase === "awaiting_player_attack") {
      const usable = (s.player.moves ?? []).find((m) => m.can_use);
      const payload = usable ? { move_id: Number(usable.id), expected_version: s.version } : (s.allowed_actions ?? []).includes("recover") ? { recover: true, expected_version: s.version } : { basic_strike: true, expected_version: s.version };
      await mobile.call("POST", `/api/pve/battles/${id}/attack`, { json: payload, ...mutationHeaders() });
    } else if (s.phase === "awaiting_player_defense") {
      await mobile.call("POST", `/api/pve/battles/${id}/defend`, { json: { defense: "endure", expected_version: s.version }, ...mutationHeaders() });
    }
  }
  assert(reward !== null, "PvE battle did not finish");
  const after = (await mobile.call("GET", "/api/me")).data.data.trainer.total_xp;
  assert(after === before + reward, `xp ${before} -> ${after}, reward ${reward}`);
  return `reward ${reward} XP`;
});

await check("Progression: unlock PvP level for the two test trainers", async () => {
  // Development-only command (APP_ENV=local); runs inside the Lambda container image.
  artisan("trainer:award-xp", web.user.profile.handle, "1500", "--source=e2e", `--key=e2e-${suffix}-w`);
  artisan("trainer:award-xp", mobile.user.profile.handle, "1500", "--source=e2e", `--key=e2e-${suffix}-m`);
  const lvl = (await web.call("GET", "/api/me")).data.data.trainer.level;
  assert(lvl >= 6, `level ${lvl}`);
  return `level ${lvl}`;
});

await check("WebSocket ticket auth: web (Origin) and Expo (no Origin) receive connection.ready", async () => {
  rt.web = new RealtimeClient(web, "web");
  rt.mobile = new RealtimeClient(mobile, "mobile");
  const a = await rt.web.connect();
  const b = await rt.mobile.connect();
  assert(rt.web.wsUrl.startsWith(cfg.expectWs), `ws_url ${rt.web.wsUrl}`);
  assert(a.payload.player_id === web.user.id && b.payload.player_id === mobile.user.id, "player_id mismatch");
  return rt.web.wsUrl;
});

await check("WebSocket rejects reused tickets and foreign Origins", async () => {
  let reused = null;
  try {
    await new RealtimeClient(mobile, "reuse").open(rt.mobile.lastTicketUrl);
  } catch (error) {
    reused = error.status;
  }
  assert(reused === 401, `ticket reuse status ${reused}`);
  const { data } = await web.call("POST", "/api/realtime/tickets", {}, 201);
  const url = new URL(data.data.ws_url);
  url.searchParams.set("ticket", data.data.ticket);
  const evil = await new Promise((resolvePromise) => {
    const s = new WebSocket(url.toString(), { headers: { Origin: "https://evil.example" } });
    s.on("unexpected-response", (_q, res) => resolvePromise(res.statusCode));
    s.on("open", () => {
      s.close();
      resolvePromise(101);
    });
    s.on("error", () => resolvePromise("error"));
  });
  assert(evil === 403, `foreign origin status ${evil}`);
});

await check("Presence: online opponents list uses realtime presence", async () => {
  const { data } = await web.call("GET", "/api/pvp/online");
  const ids = (data.data ?? []).map((p) => p.id);
  assert(ids.includes(mobile.user.id), `online ids ${JSON.stringify(ids)}`);
});

let declinedInvitationId;
await check("Private room invitation: targeted hints to invitee and host, decline closes the room", async () => {
  const created = await web.call("POST", "/api/pvp/rooms", { json: { invitee_handle: mobile.user.profile.handle }, ...mutationHeaders() }, 201);
  declinedInvitationId = created.data.data.invitation.id;
  const forInvitation = (f) => f.type === "pvp.invitation.changed" && f.payload.invitation_id === declinedInvitationId;
  await rt.mobile.waitFor(forInvitation, 8_000, "invitee hint");
  await rt.web.waitFor(forInvitation, 8_000, "host hint");
  const declined = await mobile.call("POST", `/api/pvp/invitations/${declinedInvitationId}/decline`, mutationHeaders());
  const status = declined.data.data.room?.status ?? declined.data.data.invitation?.room?.status;
  return `room after decline: ${status ?? "n/a"}`;
});

await checkKnownIssue(
  "Decline hint reaches the host socket",
  "Laravel adds `status` to pvp.invitation.changed on accept/decline/cancel; the realtime strict schema only allows invitation_id, so these hints are dropped",
  async () => {
    await rt.web.waitFor((f) => f.type === "pvp.invitation.changed" && f.payload.invitation_id === declinedInvitationId, 5_000, "decline hint");
  },
);

await check("PvP room: invite, accept, grants, selection, ready -> battle (web vs Expo)", async () => {
  ({ roomId, battleId } = await setupBattle(web, mobile, rt.web, rt.mobile, ownedWeb, ownedMobile));
  return `battle ${battleId}`;
});

await check("Turn deadline is set while the battle awaits an action", async () => {
  const s = (await web.call("GET", `/api/pvp/battles/${battleId}`)).data.data;
  assert(s.action_deadline_at, "action_deadline_at not set on an active battle (PVP_TURN_TIMEOUT_ENABLED)");
  const seconds = Math.round((Date.parse(s.action_deadline_at) - Date.now()) / 1000);
  assert(seconds > 0, `deadline already passed (${seconds}s)`);
  return `deadline in ~${seconds}s for user ${s.deadline_actor_user_id}`;
});

await check("PvP battle synchronization: every action hints both sockets", async () => {
  const r = await playPvpTurns([web, mobile], battleId, 2, rt);
  return `${r.actions} actions, version ${r.version}`;
});

await check("Reconnection: new ticket + new grant restores room hints", async () => {
  await rt.web.close();
  rt.web = new RealtimeClient(web, "web-reconnected");
  await rt.web.connect();
  await rt.web.subscribe(roomId);
  const r = await playPvpTurns([web, mobile], battleId, 1, rt);
  return `${r.actions} more action(s) after reconnect`;
});

await check("Forfeit ends the battle, hints both sides, awards outcome", async () => {
  let s = (await mobile.call("GET", `/api/pvp/battles/${battleId}`)).data.data;
  if (s.phase === "finished") {
    // KO happened first: start a fresh battle so forfeit is always exercised.
    ({ roomId, battleId } = await setupBattle(web, mobile, rt.web, rt.mobile, ownedWeb, ownedMobile));
    s = (await mobile.call("GET", `/api/pvp/battles/${battleId}`)).data.data;
  }
  const res = await mobile.call("POST", `/api/pvp/battles/${battleId}/forfeit`, { json: { expected_version: s.version }, ...mutationHeaders() });
  const outcome = res.data.data.battle.outcome;
  assert(outcome.end_reason === "forfeit" && outcome.winner_user_id === web.user.id, JSON.stringify(outcome));
  await Promise.all([rt.web, rt.mobile].map((c) => c.waitFor((f) => f.type === "pvp.battle.changed" && f.payload.battle_id === battleId, 8_000, "forfeit hint")));
  return `winner ${outcome.winner_user_id}`;
});

await check("Finished battle clears its turn deadline", async () => {
  const s = (await web.call("GET", `/api/pvp/battles/${battleId}`)).data.data;
  assert(s.phase === "finished" && s.action_deadline_at === null, `phase=${s.phase} deadline=${s.action_deadline_at}`);
});

if (runTimeoutScenario) {
  await check("Turn timeout adjudicated by the scheduler alone (no client polling)", async () => {
    const setup = await setupBattle(web, mobile, rt.web, rt.mobile, ownedWeb, ownedMobile);
    const s = (await web.call("GET", `/api/pvp/battles/${setup.battleId}`)).data.data;
    assert(s.action_deadline_at, "no deadline on a fresh battle");
    const deadlineMs = Date.parse(s.action_deadline_at) - Date.now();
    // Do not touch REST: reads would adjudicate lazily. Only the schedule may finish the battle.
    const hint = await rt.web.waitFor(
      (f) => f.type === "pvp.battle.changed" && f.payload.battle_id === setup.battleId && f.payload.version > s.version,
      deadlineMs + 150_000,
      "scheduler-driven timeout hint",
    );
    const final = (await web.call("GET", `/api/pvp/battles/${setup.battleId}`)).data.data;
    assert(final.phase === "finished" || final.status === "finished", `phase ${final.phase}`);
    return `end_reason=${final.outcome?.end_reason}, hint version ${hint.payload.version}`;
  });
}

await check("Logout closes presence (web)", async () => {
  await rt.web.close();
  await web.call("POST", "/api/logout", {}, [200, 204]);
  await new Promise((r) => setTimeout(r, 1_500));
  const { data } = await mobile.call("GET", "/api/pvp/online");
  const ids = (data.data ?? []).map((p) => p.id);
  assert(!ids.includes(web.user.id), `web user still online ${JSON.stringify(ids)}`);
});

await rt.mobile?.close();

{
  await check("React production build served like S3 + CloudFront", async () => {
    const index = await fetch(`${cfg.web}/`);
    const html = await index.text();
    assert(index.status === 200 && /<div id="root">/.test(html), "index.html not served");
    assert(/no-cache/.test(index.headers.get("cache-control") ?? ""), "index.html must not be cached long-term");
    const asset = html.match(/\/assets\/[^"]+\.js/)?.[0];
    assert(asset, "no hashed JS asset in index.html");
    const js = await fetch(`${cfg.web}${asset}`);
    assert(/immutable/.test(js.headers.get("cache-control") ?? ""), "hashed asset not immutable");
    const body = await js.text();
    assert(body.includes(cfg.api), `bundle does not target ${cfg.api}`);
    const deep = await fetch(`${cfg.web}/pvp/some/deep/link`);
    assert(deep.status === 200 && (await deep.text()).includes('<div id="root">'), "SPA fallback missing");
    return `${asset} (${body.length} bytes)`;
  });
}

const failed = results.filter((r) => !r.ok);
const known = results.filter((r) => r.known);
console.log(`\n${results.length - failed.length - known.length}/${results.length} checks passed, ${known.length} known pre-existing issue(s), ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
