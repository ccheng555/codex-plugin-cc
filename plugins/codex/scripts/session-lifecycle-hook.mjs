#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveStateFile, saveState, writeCancelFlag, writeJobFile } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

export async function cleanupSessionJobs(cwd, sessionId, dependencies = {}) {
  if (!cwd || !sessionId) {
    return { verified: true, failures: [] };
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return { verified: true, failures: [] };
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return { verified: true, failures: [] };
  }

  const terminate = dependencies.terminateProcessTreeImpl ?? terminateProcessTree;
  const retainedJobs = [];
  const failures = [];
  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    if (job.status === "queued" && !Number.isFinite(job.pid)) {
      writeCancelFlag(workspaceRoot, job.id);
      retainedJobs.push(job);
      continue;
    }
    try {
      const expectedRootIdentity = job.processIdentity ?? null;
      const ownershipCaptureFailed = job.ownershipCaptureFailed === true;
      const outcome = await terminate(job.pid ?? Number.NaN, {
        expectedRootIdentity,
        ownershipSnapshot: null,
        requireVerifiedOwnership: ownershipCaptureFailed
      });
      if (outcome?.verified === true) {
        continue;
      }
      const cleanupFailure =
        ownershipCaptureFailed && !expectedRootIdentity
          ? `Job ${job.id} could not be verified as owned and was left alone.`
          : "Session cleanup could not verify process termination.";
      const retainedJob = {
        ...job,
        phase: "cleanup-pending",
        cleanupOutcome: outcome,
        cleanupFailure
      };
      writeJobFile(workspaceRoot, job.id, retainedJob);
      retainedJobs.push(retainedJob);
    } catch (error) {
      if (error?.code === "ESRCH") {
        continue;
      }
      const retainedJob = {
        ...job,
        phase: "cleanup-pending",
        cleanupOutcome: {
          attempted: true,
          delivered: false,
          verified: false,
          degraded: true,
          survivors: [],
          survivorIdentities: []
        },
        cleanupFailure: error instanceof Error ? error.message : String(error)
      };
      writeJobFile(workspaceRoot, job.id, retainedJob);
      retainedJobs.push(retainedJob);
      failures.push(error);
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId).concat(retainedJobs)
  });
  if (failures.length > 0) {
    throw failures[0];
  }
  return { verified: retainedJobs.length === 0, failures: [] };
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;
  const pidIdentity = brokerSession?.pidIdentity ?? null;
  const ownershipSnapshot = brokerSession?.ownershipSnapshot ?? null;
  const requireVerifiedOwnership = brokerSession?.ownershipCaptureFailed === true;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  const jobCleanup = await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  const brokerCleanup = await teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    pidIdentity,
    ownershipSnapshot,
    requireVerifiedOwnership,
    killProcess: terminateProcessTree
  });
  if (brokerCleanup?.verified === true) {
    clearBrokerSession(cwd);
  }
  if (jobCleanup?.verified !== true) {
    throw new Error("Session cleanup remains pending because process termination could not be verified.");
  }
  if (brokerCleanup?.verified !== true) {
    throw new Error("Broker cleanup remains pending because process termination could not be verified.");
  }
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
