import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

const UNIX_PROCESS_TABLE_ARGS = ["-axo", "pid=,ppid=,pgid=,stat=,lstart="];
const UNIX_PS_COMMAND = "/bin/ps";

function readUnixProcessTable(runCommandImpl, options = {}) {
  const result = runCommandImpl(UNIX_PS_COMMAND, UNIX_PROCESS_TABLE_ARGS, {
    cwd: options.cwd,
    env: options.env
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? result.stdout.trim() ?? `exit ${result.status}`;
    throw new Error(`Unable to enumerate Unix processes: ${detail || `exit ${result.status}`}`);
  }

  const processes = new Map();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const processGroupId = Number(match[3]);
    const state = match[4];
    const startedAt = match[5].trim();
    processes.set(pid, {
      pid,
      parentPid,
      processGroupId,
      state,
      startedAt,
      identity: `${pid}@${startedAt}`
    });
  }
  return processes;
}

function isRunningProcess(record) {
  return record && !record.state.startsWith("Z");
}

function collectProcessTree(rootPid, processes, rootDepth = 0) {
  const childrenByParent = new Map();
  for (const record of processes.values()) {
    const children = childrenByParent.get(record.parentPid) ?? [];
    children.push(record);
    childrenByParent.set(record.parentPid, children);
  }

  const records = [];
  const visited = new Set();
  const visit = (parentPid, depth) => {
    if (visited.has(parentPid)) {
      return;
    }
    visited.add(parentPid);
    for (const child of childrenByParent.get(parentPid) ?? []) {
      visit(child.pid, depth + 1);
      records.push({ ...child, depth: depth + 1 });
    }
  };
  visit(rootPid, rootDepth);
  const root = processes.get(rootPid);
  if (root) {
    records.push({ ...root, depth: rootDepth });
  }
  return records;
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function getProcessIdentity(pid, options = {}) {
  if (!Number.isFinite(pid) || (options.platform ?? process.platform) === "win32") {
    return null;
  }
  return readUnixProcessTable(options.runCommandImpl ?? runCommand, options).get(pid)?.identity ?? null;
}

function mergeTrackedDescendants(tracked, processes, rootPid, rootIdentity) {
  const trackedByPid = new Map([...tracked.values()].map((record) => [record.pid, record.identity]));
  const roots = [];
  const currentRoot = processes.get(rootPid);
  if (currentRoot?.identity === rootIdentity) {
    roots.push({ pid: rootPid, depth: 0 });
  }
  for (const trackedRecord of tracked.values()) {
    const current = processes.get(trackedRecord.pid);
    if (current?.identity === trackedRecord.identity) {
      roots.push({ pid: current.pid, depth: trackedRecord.depth });
    }
  }
  for (const root of roots) {
    const records = collectProcessTree(root.pid, processes, root.depth).sort((left, right) => left.depth - right.depth);
    for (const record of records) {
      const priorIdentity = trackedByPid.get(record.pid);
      if (priorIdentity && priorIdentity !== record.identity) {
        continue;
      }
      if (record.pid !== root.pid) {
        const parentIdentity = trackedByPid.get(record.parentPid);
        if (!parentIdentity || processes.get(record.parentPid)?.identity !== parentIdentity) {
          continue;
        }
      }
      if (!tracked.has(record.identity)) {
        tracked.set(record.identity, record);
        trackedByPid.set(record.pid, record.identity);
      }
    }
  }
}

function listLiveTracked(tracked, processes) {
  return [...tracked.values()].filter((record) => {
    const current = processes.get(record.pid);
    return current?.identity === record.identity && isRunningProcess(current);
  });
}

function buildSignalUnits(records) {
  const groupLeaders = new Map();
  for (const record of records) {
    if (record.pid === record.processGroupId) {
      groupLeaders.set(record.processGroupId, record);
    }
  }

  const units = [];
  for (const record of records) {
    const groupLeader = groupLeaders.get(record.processGroupId);
    if (groupLeader && groupLeader.identity !== record.identity) {
      continue;
    }
    units.push({
      record,
      group: record.pid === record.processGroupId
    });
  }
  units.sort((left, right) => right.record.depth - left.record.depth);
  return units;
}

function signalVerifiedUnit(unit, signal, { runCommandImpl, killImpl, cwd, env }) {
  const processes = readUnixProcessTable(runCommandImpl, { cwd, env });
  const current = processes.get(unit.record.pid);
  if (current?.identity !== unit.record.identity || !isRunningProcess(current)) {
    return false;
  }
  if (unit.group && current.processGroupId !== current.pid) {
    return false;
  }

  const target = unit.group ? -current.pid : current.pid;
  try {
    killImpl(target, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function signalTracked(tracked, signal, options) {
  const processes = readUnixProcessTable(options.runCommandImpl, options);
  mergeTrackedDescendants(tracked, processes, options.rootPid, options.rootIdentity);
  const units = buildSignalUnits(listLiveTracked(tracked, processes));
  let delivered = false;
  for (const unit of units) {
    delivered = signalVerifiedUnit(unit, signal, options) || delivered;
  }
  return delivered;
}

function pollTracked(tracked, options, attempts) {
  let live = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const processes = readUnixProcessTable(options.runCommandImpl, options);
    mergeTrackedDescendants(tracked, processes, options.rootPid, options.rootIdentity);
    live = listLiveTracked(tracked, processes);
    if (live.length === 0) {
      break;
    }
    if (attempt + 1 < attempts) {
      options.sleepImpl(options.pollIntervalMs);
    }
  }
  return live;
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  const initialProcesses = readUnixProcessTable(runCommandImpl, options);
  const root = initialProcesses.get(pid);
  const expectedRootIdentity = options.expectedRootIdentity ?? root?.identity ?? null;
  if (!root) {
    return {
      attempted: true,
      delivered: false,
      verified: true,
      escalated: false,
      method: "process-tree",
      targets: []
    };
  }
  if (root.identity !== expectedRootIdentity) {
    return {
      attempted: true,
      delivered: false,
      verified: true,
      escalated: false,
      identityMismatch: true,
      method: "process-tree",
      targets: []
    };
  }

  const tracked = new Map();
  for (const record of collectProcessTree(pid, initialProcesses)) {
    tracked.set(record.identity, record);
  }
  const unixOptions = {
    rootPid: pid,
    rootIdentity: expectedRootIdentity,
    runCommandImpl,
    killImpl,
    cwd: options.cwd,
    env: options.env,
    sleepImpl: options.sleepImpl ?? sleepSync,
    pollIntervalMs: options.pollIntervalMs ?? 25
  };

  let delivered = signalTracked(tracked, "SIGTERM", unixOptions);
  let live = pollTracked(tracked, unixOptions, options.termPollAttempts ?? 11);
  let escalated = false;
  if (live.length > 0) {
    escalated = true;
    delivered = signalTracked(tracked, "SIGKILL", unixOptions) || delivered;
    live = pollTracked(tracked, unixOptions, options.killPollAttempts ?? 11);
  }

  return {
    attempted: true,
    delivered,
    verified: live.length === 0,
    escalated,
    method: "process-tree",
    targets: [...tracked.values()].sort((left, right) => right.depth - left.depth).map((record) => record.pid),
    survivors: live.map((record) => record.pid)
  };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
