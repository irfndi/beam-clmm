#!/usr/bin/env bun
// Minimal ACP v1 agent used by bench/acp-transport.test.ts. Speaks newline-delimited
// JSON-RPC over stdio and only accepts CANONICAL ACP method names + integer
// protocolVersion, so a client still speaking the old agent/-prefixed methods (or a
// date-string protocolVersion) fails the handshake.
//
// On session/prompt it first issues a client callback (session/request_permission) and
// only streams the reply after the host answers that callback. A host that ignores
// inbound requests (the bug this guards against) never answers, so the reply is never
// sent and the prompt times out. The reply itself streams via session/update
// agent_message_chunk notifications and resolves the prompt with a stopReason.
import readline from "readline";

const PERMISSION_REQUEST_ID = 9001;
let awaitingPermissionAck = false;
let pendingPromptId: number | undefined;

type JsonValue = string | number | boolean | null | undefined | JsonObject | JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };
interface RequestFrame {
  id?: number;
  method?: string;
  params?: JsonObject;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isStringValue(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumberValue(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function send(msg: JsonObject): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendReply(promptId: number | undefined): void {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "sess-test",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "sess-test",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "from ACP" } },
    },
  });
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: RequestFrame;
  try {
    // SAFETY: the fixture receives newline-delimited JSON and validates its object shape below.
    const parsed = JSON.parse(line) as JsonValue;
    if (!isJsonObject(parsed)) return;
    const id = isNumberValue(parsed.id) ? parsed.id : undefined;
    const method = isStringValue(parsed.method) ? parsed.method : undefined;
    const params = isJsonObject(parsed.params) ? parsed.params : undefined;
    req = {};
    if (id !== undefined) req.id = id;
    if (method !== undefined) req.method = method;
    if (params !== undefined) req.params = params;
  } catch {
    return;
  }
  const { id, method, params } = req;

  // While awaiting the host's reply to our client callback, the next frame must be that
  // reply (a response carrying our id and no method). The content is irrelevant;
  // receiving it (rather than timing out) proves the host answers inbound ACP requests.
  if (awaitingPermissionAck) {
    if (id === PERMISSION_REQUEST_ID && !isStringValue(method)) {
      awaitingPermissionAck = false;
      sendReply(pendingPromptId);
    }
    return;
  }

  if (method === "initialize") {
    if (!isNumberValue(params?.protocolVersion)) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "protocolVersion must be an integer" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: params.protocolVersion, agentCapabilities: {} },
    });
  } else if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "sess-test" } });
  } else if (method === "session/prompt") {
    // Issue a client callback and only reply once the host answers it.
    pendingPromptId = id;
    awaitingPermissionAck = true;
    send({
      jsonrpc: "2.0",
      id: PERMISSION_REQUEST_ID,
      method: "session/request_permission",
      params: { sessionId: "sess-test" },
    });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
