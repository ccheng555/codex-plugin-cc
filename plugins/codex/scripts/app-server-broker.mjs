#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const DEFAULT_CHILD_IDLE_MS = 5 * 60 * 1000;
const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function resolveChildIdleMs(env = process.env) {
  const raw = env.CODEX_COMPANION_BROKER_CHILD_IDLE_MS;
  if (raw == null || raw === "") {
    return DEFAULT_CHILD_IDLE_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CHILD_IDLE_MS;
}

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const childIdleMs = resolveChildIdleMs();
  let appClient = null;
  let appClientStartPromise = null;
  let appClientClosePromise = null;
  let childIdleTimer = null;
  let inFlightRequests = 0;
  let shutdownPromise = null;
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeStreamRunning = false;
  const sockets = new Set();

  function cancelChildIdleClose() {
    if (childIdleTimer) {
      clearTimeout(childIdleTimer);
      childIdleTimer = null;
    }
  }

  function hasActiveWork() {
    return (
      sockets.size > 0 ||
      inFlightRequests > 0 ||
      activeRequestSocket !== null ||
      activeStreamRunning
    );
  }

  async function closeAppClient() {
    cancelChildIdleClose();
    if (appClientStartPromise) {
      await appClientStartPromise.catch(() => {});
    }
    if (appClientClosePromise) {
      await appClientClosePromise;
      return;
    }
    const client = appClient;
    appClient = null;
    if (!client) {
      return;
    }
    appClientClosePromise = client.close().catch(() => {}).finally(() => {
      appClientClosePromise = null;
    });
    await appClientClosePromise;
  }

  function scheduleChildIdleClose() {
    cancelChildIdleClose();
    if (!appClient || hasActiveWork()) {
      return;
    }
    childIdleTimer = setTimeout(() => {
      childIdleTimer = null;
      if (hasActiveWork()) {
        return;
      }
      void closeAppClient();
    }, childIdleMs);
    childIdleTimer.unref?.();
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (target) {
      send(target, message);
    }
    if (message.method === "turn/completed" && activeStreamRunning) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        const streamSocket = activeStreamSocket;
        activeStreamRunning = false;
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === streamSocket) {
          activeRequestSocket = null;
        }
        scheduleChildIdleClose();
      }
    }
  }

  async function getAppClient() {
    cancelChildIdleClose();
    if (appClient) {
      return appClient;
    }
    if (appClientClosePromise) {
      await appClientClosePromise;
    }
    if (!appClientStartPromise) {
      appClientStartPromise = CodexAppServerClient.connect(cwd, { disableBroker: true })
        .then((client) => {
          appClient = client;
          client.setNotificationHandler(routeNotification);
          return client;
        })
        .finally(() => {
          appClientStartPromise = null;
        });
    }
    return appClientStartPromise;
  }

  async function shutdown(server) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      cancelChildIdleClose();
      for (const socket of sockets) {
        socket.end();
      }
      await closeAppClient();
      await new Promise((resolve) => server.close(resolve));
      if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
        fs.unlinkSync(listenTarget.path);
      }
      if (pidFile && fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    })();
    return shutdownPromise;
  }

  const server = net.createServer((socket) => {
    cancelChildIdleClose();
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamRunning && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) ||
            (activeStreamRunning && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          inFlightRequests += 1;
          try {
            const client = await getAppClient();
            const result = await client.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          } finally {
            inFlightRequests -= 1;
            scheduleChildIdleClose();
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        if (isStreaming) {
          activeStreamRunning = true;
          activeStreamSocket = socket;
          activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, null);
        }
        inFlightRequests += 1;

        try {
          const client = await getAppClient();
          const result = await client.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming && activeStreamRunning && activeStreamSocket === socket) {
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (isStreaming && activeStreamSocket === socket) {
            activeStreamRunning = false;
            activeStreamSocket = null;
            activeStreamThreadIds = null;
          }
        } finally {
          inFlightRequests -= 1;
          scheduleChildIdleClose();
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      scheduleChildIdleClose();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      scheduleChildIdleClose();
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
