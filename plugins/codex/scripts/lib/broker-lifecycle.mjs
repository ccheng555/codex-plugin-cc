import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publishBrokerRegistration, registerBrokerOwner } from "./broker-ownership.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { captureProcessOwnership } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    if (existing.registry?.registered === true) {
      const owner = registerBrokerOwner(existing.registry, { env: options.env ?? process.env });
      if (owner.registered !== true) {
        const error = new Error(`Unable to register this session as a shared Codex broker owner (${owner.reason ?? "unknown"}).`);
        error.code = "BROKER_OWNER_REGISTRATION_FAILED";
        throw error;
      }
    }
    return existing;
  }

  if (existing) {
    const cleanup = await teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      pidIdentity: existing.pidIdentity ?? null,
      ownershipSnapshot: existing.ownershipSnapshot ?? null,
      requireVerifiedOwnership: existing.ownershipCaptureFailed === true,
      killProcess: options.killProcess ?? null
    });
    if (cleanup?.verified !== true) {
      const error = new Error("Broker cleanup is unverified; refusing to start another broker session.");
      error.code = "BROKER_CLEANUP_UNVERIFIED";
      throw error;
    }
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });
  const captureOwnership = options.captureProcessOwnershipImpl ?? captureProcessOwnership;
  let ownershipSnapshot = null;
  let ownershipCaptureFailed = false;
  if ((options.platform ?? process.platform) !== "win32") {
    try {
      ownershipSnapshot = captureOwnership(child.pid ?? Number.NaN, {
        cwd,
        env: options.env ?? process.env,
        platform: options.platform
      });
      ownershipCaptureFailed = !ownershipSnapshot?.rootIdentity;
    } catch {
      ownershipCaptureFailed = true;
    }
  }

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    const cleanup = await teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      pidIdentity: ownershipSnapshot?.rootIdentity ?? null,
      ownershipSnapshot,
      requireVerifiedOwnership: ownershipCaptureFailed,
      killProcess: options.killProcess ?? null
    });
    if (cleanup?.verified !== true) {
      return null;
    }
    return null;
  }

  let registry = null;
  try {
    const candidate = publishBrokerRegistration({
      cwd,
      endpoint,
      pid: child.pid ?? null,
      ownershipSnapshot,
      env: options.env ?? process.env
    });
    if (candidate.registered === true) {
      const owner = registerBrokerOwner(candidate, { env: options.env ?? process.env });
      if (owner.registered === true) {
        registry = candidate;
      }
    }
  } catch (error) {
    process.stderr.write(`Warning: unable to publish Codex broker ownership: ${error.message}. Broker remains unregistered.\n`);
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    pidIdentity: ownershipSnapshot?.rootIdentity ?? null,
    ownershipSnapshot,
    ownershipCaptureFailed,
    registry
  };
  saveBrokerSession(cwd, session);
  return session;
}

export async function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  pidIdentity = null,
  ownershipSnapshot = null,
  requireVerifiedOwnership = false,
  killProcess = null
}) {
  let cleanupOutcome = {
    attempted: false,
    delivered: false,
    verified: true,
    degraded: false,
    method: null,
    targets: [],
    targetIdentities: [],
    survivors: [],
    survivorIdentities: []
  };
  if (Number.isFinite(pid) && killProcess) {
    try {
      const outcome = await killProcess(pid, {
        expectedRootIdentity: pidIdentity,
        ownershipSnapshot,
        requireVerifiedOwnership
      });
      cleanupOutcome = outcome ?? {
        ...cleanupOutcome,
        attempted: true,
        verified: false,
        degraded: true
      };
    } catch (error) {
      if (error?.code !== "ESRCH" && error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (cleanupOutcome.verified !== true) {
      return cleanupOutcome;
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
  return cleanupOutcome;
}
