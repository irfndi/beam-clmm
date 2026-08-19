import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { HermesApiTransport } from "../engine/hermes-api-transport.js";
import type { AgentRuntimeContext } from "../engine/agent-transport.js";
import type { AgentDecision } from "../engine/types.js";

function makeContext(): AgentRuntimeContext {
  // SAFETY: this fixture contains all fields consumed by HermesApiTransport.
  return {
    decision: {
      action: "HOLD",
      poolAddress: "Pool111111111111111111111111111111111111111",
      confidence: 0.65,
      reasoning: "test decision",
    } satisfies AgentDecision,
  } as AgentRuntimeContext;
}

describe("HermesApiTransport (OpenAI-compatible API)", () => {
  it("POSTs a chat-completions request and parses choices[0].message.content", async () => {
    let capturedPath = "";
    let capturedAuth = "";
    let capturedBody: object | null = null;

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        capturedPath = url.pathname;
        capturedAuth = request.headers.get("authorization") ?? "";
        if (url.pathname === "/v1/chat/completions") {
          const body: unknown = await request.json();
          if (Object.prototype.toString.call(body) !== "[object Object]") {
            throw new Error("request body must be an object");
          }
          // SAFETY: the endpoint contract requires a JSON object request body.
          capturedBody = body as object;
          return Response.json({
            choices: [
              { message: { role: "assistant", content: '{"action":"HOLD","confidence":0.5}' } },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const transport = new HermesApiTransport({
        url: `http://127.0.0.1:${server.port}`,
        token: "api-key-123",
        timeoutMs: 5000,
      });
      const response = await Effect.runPromise(transport.sendPrompt("review this", makeContext()));

      expect(capturedPath).toBe("/v1/chat/completions");
      expect(capturedBody).toMatchObject({
        model: "hermes-agent",
        stream: false,
        messages: [{ role: "user", content: "review this" }],
      });
      expect(capturedAuth).toBe("Bearer api-key-123");
      expect(response.raw).toBe('{"action":"HOLD","confidence":0.5}');
    } finally {
      void server.stop(true);
    }
  });

  it("isAvailable checks the /health endpoint", async () => {
    let capturedPath = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        capturedPath = new URL(request.url).pathname;
        return Response.json({ ok: true });
      },
    });

    try {
      const transport = new HermesApiTransport({
        url: `http://127.0.0.1:${server.port}`,
        token: "",
        timeoutMs: 5000,
      });
      const available = await Effect.runPromise(transport.isAvailable());
      expect(available).toBe(true);
      expect(capturedPath).toBe("/health");
    } finally {
      void server.stop(true);
    }
  });
});
