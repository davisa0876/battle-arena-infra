// Battle Arena local AWS edge gateway (local development only, never deployed).
//
// Emulates, for local use only, the AWS managed pieces that sit in front of the Lambda
// container images (which run the official AWS Lambda Runtime Interface Emulator):
//
//   :HTTP_PORT  API Gateway HTTP API  (payload format 2.0, $default route -> HTTP function)
//   :WS_PORT    API Gateway WebSocket API ($connect / $default / $disconnect -> WS function)
//   :AWS_PORT   Internal "AWS endpoint": Lambda Invoke API (RequestResponse + Event) and the
//               API Gateway Management API (@connections). Not published to the host.
//   scheduler   EventBridge-style fixed-rate rules (e.g. artisan schedule:run every minute)
//
// It never contacts AWS. Behaviour and limits follow the public AWS documentation, but this is
// an emulator: see battle-arena-infra/README.md "Remaining differences" before trusting it.

import { randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";

import { WebSocketServer } from "ws";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const env = process.env;
const num = (name, fallback) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
};

const config = {
  httpPort: num("HTTP_PORT", 8100),
  wsPort: num("WS_PORT", 3101),
  awsPort: num("AWS_PORT", 9001),
  region: env.AWS_REGION ?? "us-east-1",
  accountId: "000000000000",
  httpApiId: env.HTTP_API_ID ?? "localhttp",
  wsApiId: env.WS_API_ID ?? "localws",
  wsStage: env.WS_STAGE ?? "prod",
  httpFunction: env.HTTP_API_FUNCTION ?? "battle-arena-api",
  wsFunction: env.WS_API_FUNCTION ?? "battle-arena-realtime",
  // HTTP API: 30 s max integration timeout, 10 MB max request payload.
  httpIntegrationTimeoutMs: num("HTTP_API_INTEGRATION_TIMEOUT_MS", 30_000),
  httpMaxRequestBytes: num("HTTP_API_MAX_REQUEST_BYTES", 10 * 1024 * 1024),
  // Lambda: 6 MB synchronous request/response payload, 256 KB async payload.
  lambdaSyncPayloadBytes: num("LAMBDA_SYNC_PAYLOAD_BYTES", 6 * 1024 * 1024),
  lambdaAsyncPayloadBytes: num("LAMBDA_ASYNC_PAYLOAD_BYTES", 256 * 1024),
  lambdaAsyncRetries: num("LAMBDA_ASYNC_RETRIES", 2),
  lambdaAsyncRetryDelayMs: num("LAMBDA_ASYNC_RETRY_DELAY_MS", 1_000),
  lambdaQueueTimeoutMs: num("LAMBDA_QUEUE_TIMEOUT_MS", 30_000),
  // WebSocket API: 10 min idle, 2 h max connection, 128 KB message, 29 s integration timeout.
  wsIdleTimeoutMs: num("WS_IDLE_TIMEOUT_MS", 10 * 60_000),
  wsMaxDurationMs: num("WS_MAX_DURATION_MS", 2 * 60 * 60_000),
  wsMaxMessageBytes: num("WS_MAX_MESSAGE_BYTES", 128 * 1024),
  wsIntegrationTimeoutMs: num("WS_INTEGRATION_TIMEOUT_MS", 29_000),
  publicWsHost: env.WS_PUBLIC_DOMAIN ?? "",
  functions: parseFunctions(env.LAMBDA_FUNCTIONS ?? ""),
  schedules: parseSchedules(env.SCHEDULES ?? ""),
};

/** LAMBDA_FUNCTIONS="name=host:port,name2=host2:port" (host may resolve to several replicas). */
function parseFunctions(raw) {
  const map = new Map();
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [name, target] = part.split("=");
    const [host, port] = (target ?? "").split(":");
    if (!name || !host || !port) throw new Error(`invalid LAMBDA_FUNCTIONS entry: ${part}`);
    map.set(name, { name, host, port: Number(port) });
  }
  return map;
}

/** SCHEDULES="function|rate-seconds|json-payload;..." */
function parseSchedules(raw) {
  return raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const [fn, rate, ...payload] = part.split("|");
      return { fn, rateSeconds: Number(rate), payload: payload.join("|") };
    });
}

const log = (level, msg, extra = {}) =>
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, service: "gateway", msg, ...extra })}\n`,
  );

// ---------------------------------------------------------------------------------------------
// Lambda service emulation: route invocations to RIE containers, one invocation per
// execution environment at a time (RIE is single-concurrency, exactly like a Lambda sandbox).
// Scale with `docker compose up --scale <service>=N` to get N execution environments.
// ---------------------------------------------------------------------------------------------

class FunctionPool {
  constructor(fn) {
    this.fn = fn;
    this.busy = new Set();
    this.waiters = [];
  }

  async addresses() {
    try {
      const results = await lookup(this.fn.host, { all: true, family: 4 });
      return results.map((r) => r.address);
    } catch {
      return [];
    }
  }

  async acquire() {
    const deadline = Date.now() + config.lambdaQueueTimeoutMs;
    for (;;) {
      const free = (await this.addresses()).find((a) => !this.busy.has(a));
      if (free) {
        this.busy.add(free);
        return free;
      }
      if (Date.now() > deadline) {
        const error = new Error("TooManyRequestsException: Rate Exceeded.");
        error.code = "TooManyRequestsException";
        throw error;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  release(address) {
    this.busy.delete(address);
    const next = this.waiters.shift();
    if (next) next();
  }
}

const pools = new Map([...config.functions.values()].map((fn) => [fn.name, new FunctionPool(fn)]));

function resolveFunctionName(raw) {
  const decoded = decodeURIComponent(raw);
  // Accept plain names, ARNs and name:qualifier.
  const name = decoded.startsWith("arn:") ? decoded.split(":")[6] : decoded.split(":")[0];
  return pools.has(name) ? name : null;
}

/**
 * Synchronous invoke. Resolves to { ok, functionError, payload (Buffer), durationMs }.
 * functionError mirrors the X-Amz-Function-Error header ("Unhandled").
 */
async function invokeFunction(name, payloadBuffer, { timeoutMs } = {}) {
  const pool = pools.get(name);
  if (!pool) throw Object.assign(new Error(`Function not found: ${name}`), { code: "ResourceNotFoundException" });
  if (payloadBuffer.length > config.lambdaSyncPayloadBytes) {
    throw Object.assign(new Error("Request payload size exceeded"), { code: "RequestTooLargeException" });
  }

  const address = await pool.acquire();
  const started = Date.now();
  try {
    const { status, body } = await postRaw(
      { host: address, port: pool.fn.port, path: "/2015-03-31/functions/function/invocations" },
      payloadBuffer,
      timeoutMs ?? config.httpIntegrationTimeoutMs,
    );
    let functionError = null;
    if (status !== 200) {
      functionError = "Unhandled";
    } else {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        if (parsed && typeof parsed === "object" && "errorType" in parsed && "errorMessage" in parsed && !("statusCode" in parsed)) {
          functionError = "Unhandled";
        }
      } catch {
        // Non-JSON payloads are valid function results.
      }
    }
    if (body.length > config.lambdaSyncPayloadBytes) {
      return { ok: false, functionError: "Unhandled", payload: Buffer.from(JSON.stringify({ errorType: "ResponseSizeTooLarge" })), durationMs: Date.now() - started };
    }
    return { ok: functionError === null, functionError, payload: body, durationMs: Date.now() - started };
  } finally {
    pool.release(address);
  }
}

/** Async (Event) invoke with Lambda-style retries on function errors. */
function invokeAsync(name, payloadBuffer) {
  if (payloadBuffer.length > config.lambdaAsyncPayloadBytes) {
    throw Object.assign(new Error("Request payload size exceeded"), { code: "RequestTooLargeException" });
  }
  const requestId = randomUUID();
  void (async () => {
    for (let attempt = 0; attempt <= config.lambdaAsyncRetries; attempt += 1) {
      try {
        const result = await invokeFunction(name, payloadBuffer, { timeoutMs: 900_000 });
        if (result.ok) return;
        log("warn", "async invoke function error", { function: name, requestId, attempt, payload: truncate(result.payload) });
      } catch (error) {
        log("warn", "async invoke failed", { function: name, requestId, attempt, err: error.message });
      }
      await sleep(config.lambdaAsyncRetryDelayMs * (attempt + 1));
    }
    log("error", "async invoke dropped after retries (no DLQ configured)", { function: name, requestId });
  })();
  return requestId;
}

function postRaw(target, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { ...target, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": body.length } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("integration timeout"), { code: "IntegrationTimeout" })));
    req.on("error", reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (buf) => buf.toString("utf8").slice(0, 500);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("payload too large"), { code: "PayloadTooLarge" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": payload.length, ...headers });
  res.end(payload);
}

function clientIp(req) {
  return (req.socket.remoteAddress ?? "127.0.0.1").replace(/^::ffff:/, "");
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

function apiGatewayRequestId() {
  return randomBytes(12).toString("base64url").slice(0, 16) + "=";
}

// ---------------------------------------------------------------------------------------------
// API Gateway HTTP API (payload format version 2.0)
// ---------------------------------------------------------------------------------------------

function buildHttpEvent(req, body) {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const headers = {};
  let cookies;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i].toLowerCase();
    const value = req.rawHeaders[i + 1];
    if (key === "cookie") {
      cookies = [...(cookies ?? []), ...value.split(/;\s*/).filter(Boolean)];
      continue;
    }
    headers[key] = headers[key] === undefined ? value : `${headers[key]},${value}`;
  }
  const sourceIp = clientIp(req);
  const host = headers.host ?? `localhost:${config.httpPort}`;
  headers["x-forwarded-for"] = headers["x-forwarded-for"] ? `${headers["x-forwarded-for"]}, ${sourceIp}` : sourceIp;
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-port"] = String(config.httpPort);
  headers["x-amzn-trace-id"] = `Root=1-${Math.floor(Date.now() / 1000).toString(16)}-${randomBytes(12).toString("hex")}`;

  const query = {};
  for (const [k, v] of url.searchParams) query[k] = query[k] === undefined ? v : `${query[k]},${v}`;

  const contentType = headers["content-type"] ?? "";
  const isText = body.length === 0 || TEXT_TYPES.test(contentType);
  const now = new Date();

  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ""),
    ...(cookies ? { cookies } : {}),
    headers,
    ...(Object.keys(query).length ? { queryStringParameters: query } : {}),
    requestContext: {
      accountId: config.accountId,
      apiId: config.httpApiId,
      domainName: host.split(":")[0],
      domainPrefix: host.split(".")[0].split(":")[0],
      http: {
        method: req.method ?? "GET",
        path: url.pathname,
        protocol: `HTTP/${req.httpVersion}`,
        sourceIp,
        userAgent: headers["user-agent"] ?? "",
      },
      requestId: apiGatewayRequestId(),
      routeKey: "$default",
      stage: "$default",
      time: now.toUTCString(),
      timeEpoch: now.getTime(),
    },
    ...(body.length ? { body: isText ? body.toString("utf8") : body.toString("base64") } : {}),
    isBase64Encoded: !isText,
  };
}

function writeHttpResult(res, payload, requestId) {
  let result;
  try {
    result = JSON.parse(payload.toString("utf8"));
  } catch {
    return sendJson(res, 500, { message: "Internal Server Error" }, { "apigw-requestid": requestId });
  }

  // Payload 2.0: a response without statusCode is treated as a 200 JSON body.
  if (!result || typeof result !== "object" || !("statusCode" in result)) {
    return sendJson(res, 200, result, { "apigw-requestid": requestId });
  }

  const body = result.body === undefined || result.body === null
    ? Buffer.alloc(0)
    : Buffer.from(String(result.body), result.isBase64Encoded ? "base64" : "utf8");
  const headers = { "apigw-requestid": requestId };
  for (const [k, v] of Object.entries(result.headers ?? {})) {
    if (k.toLowerCase() === "content-length") continue;
    headers[k] = String(v);
  }
  for (const [k, values] of Object.entries(result.multiValueHeaders ?? {})) {
    headers[k] = values.map(String);
  }
  if (Array.isArray(result.cookies) && result.cookies.length) {
    headers["Set-Cookie"] = result.cookies.map(String);
  }
  headers["Content-Length"] = body.length;
  res.writeHead(Number(result.statusCode), headers);
  res.end(body);
}

const httpServer = createServer(async (req, res) => {
  const started = Date.now();
  const requestId = randomUUID();
  let status = 0;
  res.on("finish", () => {
    status = res.statusCode;
    log("info", "http api request", { method: req.method, path: (req.url ?? "").split("?")[0], status, ms: Date.now() - started });
  });

  let body;
  try {
    body = await readBody(req, config.httpMaxRequestBytes);
  } catch {
    return sendJson(res, 413, { message: "Request Entity Too Large" });
  }

  const event = Buffer.from(JSON.stringify(buildHttpEvent(req, body)));
  try {
    const result = await invokeFunction(config.httpFunction, event, { timeoutMs: config.httpIntegrationTimeoutMs });
    if (result.functionError) {
      log("error", "http function error", { payload: truncate(result.payload) });
      return sendJson(res, 500, { message: "Internal Server Error" }, { "apigw-requestid": requestId });
    }
    return writeHttpResult(res, result.payload, requestId);
  } catch (error) {
    if (error.code === "RequestTooLargeException") return sendJson(res, 413, { message: "Request Entity Too Large" });
    if (error.code === "IntegrationTimeout") return sendJson(res, 503, { message: "Service Unavailable" });
    if (error.code === "TooManyRequestsException") return sendJson(res, 503, { message: "Service Unavailable" });
    log("error", "http integration failure", { err: error.message });
    return sendJson(res, 500, { message: "Internal Server Error" });
  }
});

// ---------------------------------------------------------------------------------------------
// API Gateway WebSocket API
// ---------------------------------------------------------------------------------------------

/** connectionId -> { socket, connectedAt, lastActiveAt, sourceIp, userAgent, timers } */
const connections = new Map();
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: config.wsMaxMessageBytes });

function newConnectionId() {
  return randomBytes(10).toString("base64").replace(/[^A-Za-z0-9]/g, "A").slice(0, 15) + "=";
}

function wsRequestContext(connectionId, routeKey, eventType, extra = {}) {
  const conn = connections.get(connectionId);
  const now = Date.now();
  return {
    routeKey,
    eventType,
    extendedRequestId: apiGatewayRequestId(),
    requestTime: new Date(now).toUTCString(),
    messageDirection: "IN",
    stage: config.wsStage,
    connectedAt: conn?.connectedAt ?? now,
    requestTimeEpoch: now,
    identity: { sourceIp: conn?.sourceIp ?? extra.sourceIp ?? "127.0.0.1", userAgent: conn?.userAgent ?? extra.userAgent ?? "" },
    requestId: apiGatewayRequestId(),
    domainName: config.publicWsHost || `localhost:${config.wsPort}`,
    connectionId,
    apiId: config.wsApiId,
    ...extra.ctx,
  };
}

async function invokeWs(event) {
  return invokeFunction(config.wsFunction, Buffer.from(JSON.stringify(event)), { timeoutMs: config.wsIntegrationTimeoutMs });
}

function rejectUpgrade(socket, status, message) {
  const body = JSON.stringify({ message });
  const reason = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable" }[status] ?? "Error";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  socket.destroy();
}

function dropConnection(connectionId, code, reason) {
  const conn = connections.get(connectionId);
  if (!conn) return;
  try {
    conn.socket.close(code, reason);
  } catch {
    conn.socket.terminate();
  }
}

const wsHttpServer = createServer((req, res) => sendJson(res, 426, { message: "Upgrade Required" }));

wsHttpServer.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://placeholder");
  if (url.pathname.replace(/\/+$/, "") !== `/${config.wsStage}`) {
    return rejectUpgrade(socket, 403, "Forbidden");
  }

  const connectionId = newConnectionId();
  const headers = {};
  const multiValueHeaders = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i];
    headers[key] = req.rawHeaders[i + 1];
    multiValueHeaders[key] = [...(multiValueHeaders[key] ?? []), req.rawHeaders[i + 1]];
  }
  const query = {};
  const multiQuery = {};
  for (const [k, v] of url.searchParams) {
    query[k] = v;
    multiQuery[k] = [...(multiQuery[k] ?? []), v];
  }
  const sourceIp = clientIp(req);
  const userAgent = req.headers["user-agent"] ?? "";

  const event = {
    headers,
    multiValueHeaders,
    ...(Object.keys(query).length ? { queryStringParameters: query, multiValueQueryStringParameters: multiQuery } : {}),
    requestContext: wsRequestContext(connectionId, "$connect", "CONNECT", { sourceIp, userAgent }),
    isBase64Encoded: false,
  };

  let result;
  try {
    result = await invokeWs(event);
  } catch (error) {
    log("error", "$connect integration failure", { err: error.message });
    return rejectUpgrade(socket, 500, "Internal server error");
  }
  if (result.functionError) {
    log("error", "$connect function error", { payload: truncate(result.payload) });
    return rejectUpgrade(socket, 500, "Internal server error");
  }

  let statusCode = 200;
  try {
    const parsed = JSON.parse(result.payload.toString("utf8"));
    if (parsed && typeof parsed === "object" && "statusCode" in parsed) statusCode = Number(parsed.statusCode);
  } catch {
    // A non-JSON result counts as success, as in API Gateway.
  }
  if (statusCode < 200 || statusCode > 299) {
    log("info", "$connect rejected", { statusCode });
    return rejectUpgrade(socket, statusCode, statusCode === 403 ? "Forbidden" : "Unauthorized");
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const now = Date.now();
    const conn = { socket: ws, connectedAt: now, lastActiveAt: now, sourceIp, userAgent, idleTimer: null, maxTimer: null };
    connections.set(connectionId, conn);

    const armIdle = () => {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = setTimeout(() => dropConnection(connectionId, 1001, "Going away"), config.wsIdleTimeoutMs);
    };
    armIdle();
    conn.maxTimer = setTimeout(() => dropConnection(connectionId, 1001, "Going away"), config.wsMaxDurationMs);

    ws.on("message", (data, isBinary) => {
      conn.lastActiveAt = Date.now();
      armIdle();
      const messageEvent = {
        requestContext: wsRequestContext(connectionId, "$default", "MESSAGE", { ctx: { messageId: apiGatewayRequestId() } }),
        body: isBinary ? Buffer.from(data).toString("base64") : Buffer.from(data).toString("utf8"),
        isBase64Encoded: Boolean(isBinary),
      };
      invokeWs(messageEvent)
        .then((r) => {
          if (r.functionError) throw new Error(truncate(r.payload));
        })
        .catch((error) => {
          log("error", "$default integration failure", { connectionId, err: error.message });
          // API Gateway reports integration failures to the client as a JSON frame.
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ message: "Internal server error", connectionId, requestId: apiGatewayRequestId() }));
          }
        });
    });

    ws.on("close", (code, reasonBuffer) => {
      clearTimeout(conn.idleTimer);
      clearTimeout(conn.maxTimer);
      connections.delete(connectionId);
      // $disconnect is best-effort in API Gateway; failures are only logged.
      invokeWs({
        headers: {},
        requestContext: wsRequestContext(connectionId, "$disconnect", "DISCONNECT", {
          sourceIp,
          userAgent,
          ctx: { disconnectStatusCode: code, disconnectReason: reasonBuffer.toString("utf8") },
        }),
        isBase64Encoded: false,
      }).catch((error) => log("warn", "$disconnect integration failure", { connectionId, err: error.message }));
    });

    ws.on("error", (error) => log("warn", "socket error", { connectionId, err: error.message }));
    log("info", "websocket connected", { connectionId, open: connections.size });
  });
});

// ---------------------------------------------------------------------------------------------
// Internal AWS endpoint: Lambda Invoke API + API Gateway Management API
// ---------------------------------------------------------------------------------------------

function awsError(res, status, type, message) {
  sendJson(res, status, { message, Type: "User" }, { "x-amzn-ErrorType": type, "x-amzn-RequestId": randomUUID() });
}

const awsServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://placeholder");

  if (req.method === "GET" && url.pathname === "/__local/health") {
    return sendJson(res, 200, { status: "ok", functions: [...pools.keys()], websocketConnections: connections.size });
  }

  // Lambda Invoke: POST /2015-03-31/functions/{name}/invocations
  const invokeMatch = url.pathname.match(/^\/2015-03-31\/functions\/([^/]+)\/invocations$/);
  if (invokeMatch && req.method === "POST") {
    const name = resolveFunctionName(invokeMatch[1]);
    if (!name) return awsError(res, 404, "ResourceNotFoundException", `Function not found: ${invokeMatch[1]}`);
    let body;
    try {
      body = await readBody(req, config.lambdaSyncPayloadBytes + 1);
    } catch {
      return awsError(res, 413, "RequestTooLargeException", "Request must be smaller than 6291456 bytes for the InvokeFunction operation");
    }
    if (body.length === 0) body = Buffer.from("{}");
    const invocationType = String(req.headers["x-amz-invocation-type"] ?? "RequestResponse");
    try {
      if (invocationType === "Event") {
        const requestId = invokeAsync(name, body);
        res.writeHead(202, { "x-amzn-RequestId": requestId, "Content-Length": 0 });
        return res.end();
      }
      if (invocationType === "DryRun") {
        res.writeHead(204, { "Content-Length": 0 });
        return res.end();
      }
      const result = await invokeFunction(name, body, { timeoutMs: 900_000 });
      const headers = { "Content-Type": "application/json", "X-Amz-Executed-Version": "$LATEST", "Content-Length": result.payload.length };
      if (result.functionError) headers["X-Amz-Function-Error"] = result.functionError;
      res.writeHead(200, headers);
      return res.end(result.payload);
    } catch (error) {
      if (error.code === "RequestTooLargeException") return awsError(res, 413, error.code, error.message);
      if (error.code === "TooManyRequestsException") return awsError(res, 429, error.code, "Rate Exceeded.");
      return awsError(res, 502, "ServiceException", error.message);
    }
  }

  // Management API: /{stage}/@connections/{connectionId}
  const mgmtMatch = url.pathname.match(/^(?:\/([^/]+))?\/@connections\/([^/]+)$/);
  if (mgmtMatch) {
    const connectionId = decodeURIComponent(mgmtMatch[2]);
    const conn = connections.get(connectionId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      // Includes connections whose $connect has not returned yet, as in API Gateway.
      return awsError(res, 410, "GoneException", null);
    }
    if (req.method === "POST") {
      let body;
      try {
        body = await readBody(req, config.wsMaxMessageBytes);
      } catch {
        return awsError(res, 413, "PayloadTooLargeException", "Message too long");
      }
      conn.socket.send(body.toString("utf8"));
      res.writeHead(200, { "Content-Length": 0 });
      return res.end();
    }
    if (req.method === "DELETE") {
      dropConnection(connectionId, 1000, "");
      res.writeHead(204, { "Content-Length": 0 });
      return res.end();
    }
    if (req.method === "GET") {
      return sendJson(res, 200, {
        ConnectedAt: new Date(conn.connectedAt).toISOString(),
        Identity: { SourceIp: conn.sourceIp, UserAgent: conn.userAgent },
        LastActiveAt: new Date(conn.lastActiveAt).toISOString(),
      });
    }
  }

  return awsError(res, 404, "UnknownOperationException", "Unknown operation");
});

// ---------------------------------------------------------------------------------------------
// EventBridge-style fixed-rate schedules
// ---------------------------------------------------------------------------------------------

for (const schedule of config.schedules) {
  if (!pools.has(schedule.fn) || !(schedule.rateSeconds >= 60)) {
    throw new Error(`invalid schedule ${JSON.stringify(schedule)} (EventBridge minimum rate is 1 minute)`);
  }
  const fire = () => {
    log("info", "schedule fired", { function: schedule.fn, payload: schedule.payload });
    try {
      invokeAsync(schedule.fn, Buffer.from(schedule.payload));
    } catch (error) {
      log("error", "schedule invoke failed", { err: error.message });
    }
  };
  // Align to the start of the next minute, like rate(1 minute) rules in practice.
  setTimeout(() => {
    fire();
    setInterval(fire, schedule.rateSeconds * 1000);
  }, 60_000 - (Date.now() % 60_000));
}

// ---------------------------------------------------------------------------------------------

httpServer.listen(config.httpPort, "0.0.0.0", () => log("info", "HTTP API listening", { port: config.httpPort, function: config.httpFunction }));
wsHttpServer.listen(config.wsPort, "0.0.0.0", () => log("info", "WebSocket API listening", { port: config.wsPort, stage: config.wsStage, function: config.wsFunction }));
awsServer.listen(config.awsPort, "0.0.0.0", () => log("info", "Lambda + Management API listening", { port: config.awsPort, functions: [...pools.keys()] }));

const shutdown = () => {
  for (const id of connections.keys()) dropConnection(id, 1001, "Going away");
  httpServer.close();
  wsHttpServer.close();
  awsServer.close();
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
