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
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
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
const UNIX_PS_PATH_COMMAND = "ps";

function createProcessTableError(message) {
  const error = new Error(message);
  error.code = "PROCESS_TABLE_UNAVAILABLE";
  return error;
}

function readUnixProcessTable(runCommandImpl, options = {}) {
  let result = runCommandImpl(UNIX_PS_COMMAND, UNIX_PROCESS_TABLE_ARGS, {
    cwd: options.cwd,
    env: options.env
  });
  if (result.error?.code === "ENOENT") {
    result = runCommandImpl(UNIX_PS_PATH_COMMAND, UNIX_PROCESS_TABLE_ARGS, {
      cwd: options.cwd,
      env: options.env
    });
  }
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw createProcessTableError(`Unable to enumerate Unix processes: ${detail || `exit ${result.status}`}`);
  }

  const processes = new Map();
  for (const line of result.stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    const match = trimmedLine.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) {
      throw createProcessTableError(`Unable to parse Unix process table line: ${trimmedLine}`);
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const processGroupId = Number(match[3]);
    const state = match[4];
    const startedAt = match[5].trim();
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(processGroupId) || !startedAt) {
      throw createProcessTableError(`Unable to parse Unix process table line: ${trimmedLine}`);
    }
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

function sleep(milliseconds) {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function getProcessIdentity(pid, options = {}) {
  if (!Number.isFinite(pid) || (options.platform ?? process.platform) === "win32") {
    return null;
  }
  return readUnixProcessTable(options.runCommandImpl ?? runCommand, options).get(pid)?.identity ?? null;
}

export function getLiveProcessPids(pids, options = {}) {
  const candidates = [...new Set(pids.filter((pid) => Number.isFinite(pid)))];
  if (candidates.length === 0) {
    return [];
  }
  if ((options.platform ?? process.platform) === "win32") {
    const killImpl = options.killImpl ?? process.kill.bind(process);
    return candidates.filter((pid) => {
      try {
        killImpl(pid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    });
  }

  try {
    const processes = readUnixProcessTable(options.runCommandImpl ?? runCommand, options);
    return candidates.filter((pid) => isRunningProcess(processes.get(pid)));
  } catch {
    // An unverified cleanup remains blocked when liveness cannot be checked.
    return candidates;
  }
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

function mergeTrackedGroupMembers(tracked, processes, units) {
  const trackedByPid = new Map([...tracked.values()].map((record) => [record.pid, record.identity]));
  for (const unit of units) {
    if (!unit.group) {
      continue;
    }
    for (const record of processes.values()) {
      if (record.processGroupId !== unit.record.processGroupId) {
        continue;
      }
      const priorIdentity = trackedByPid.get(record.pid);
      if (priorIdentity && priorIdentity !== record.identity) {
        continue;
      }
      if (!tracked.has(record.identity)) {
        tracked.set(record.identity, { ...record, depth: unit.record.depth + 1 });
        trackedByPid.set(record.pid, record.identity);
      }
    }
  }
}

function signalVerifiedUnit(unit, signal, processes, killImpl) {
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

function withoutExcluded(records, excludePids) {
  if (!excludePids || excludePids.size === 0) {
    return records;
  }
  return records.filter((record) => !excludePids.has(record.pid));
}

function signalTracked(tracked, signal, options) {
  const processes = readUnixProcessTable(options.runCommandImpl, options);
  mergeTrackedDescendants(tracked, processes, options.rootPid, options.rootIdentity);
  mergeTrackedGroupMembers(tracked, processes, buildSignalUnits(listLiveTracked(tracked, processes)));
  const units = buildSignalUnits(withoutExcluded(listLiveTracked(tracked, processes), options.excludePids));
  let delivered = false;
  for (const unit of units) {
    delivered = signalVerifiedUnit(unit, signal, processes, options.killImpl) || delivered;
  }
  return delivered;
}

async function pollTracked(tracked, options, attempts) {
  let live = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const processes = readUnixProcessTable(options.runCommandImpl, options);
    mergeTrackedDescendants(tracked, processes, options.rootPid, options.rootIdentity);
    live = withoutExcluded(listLiveTracked(tracked, processes), options.excludePids);
    if (live.length === 0) {
      break;
    }
    if (attempt + 1 < attempts) {
      await options.sleepImpl(options.pollIntervalMs);
    }
  }
  return live;
}

function warnProcessCleanup(message, options) {
  const warnImpl = options.warnImpl ?? ((warning) => process.stderr.write(`${warning}\n`));
  try {
    warnImpl(message);
  } catch {
    // Cleanup warnings must not turn a best-effort kill into a host failure.
  }
}

function degradedDirectChildKill(pid, options, killImpl, reason) {
  const directKillImpl = options.directKillImpl ?? ((signal) => killImpl(pid, signal));
  let delivered = false;
  try {
    delivered = directKillImpl("SIGKILL") !== false;
  } catch {
    // The direct child may already have exited.
  }
  warnProcessCleanup(
    `Unable to verify Unix process cleanup for PID ${pid}; used direct-child kill fallback (${String(reason).replace(/\s+/g, " ").trim()}). Surviving PIDs: none known.`,
    options
  );
  return {
    attempted: true,
    delivered,
    verified: false,
    escalated: false,
    degraded: true,
    method: "direct-child",
    targets: [pid],
    survivors: []
  };
}

export async function terminateProcessTree(pid, options = {}) {
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

  let initialProcesses;
  try {
    initialProcesses = readUnixProcessTable(runCommandImpl, options);
  } catch (error) {
    if (error?.code !== "PROCESS_TABLE_UNAVAILABLE") {
      throw error;
    }
    return degradedDirectChildKill(pid, options, killImpl, error.message);
  }
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
    sleepImpl: options.sleepImpl ?? sleep,
    pollIntervalMs: options.pollIntervalMs ?? 25
  };

  try {
    let delivered = false;
    let escalated = false;
    let live = [];
    // Terminate descendants first and wait for them while their parent is
    // still alive, so the parent can reap them; killing the whole tree
    // back-to-back leaves permanent zombies where PID 1 does not reap orphans
    // (containers). Both phases share the one tracked map so PID-reuse
    // identity memory carries across phases; the descendant phase only
    // excludes the root pid from signaling and liveness.
    const hasDescendants = [...tracked.values()].some((record) => record.pid !== pid);
    const phases = hasDescendants
      ? [{ ...unixOptions, excludePids: new Set([pid]) }, unixOptions]
      : [unixOptions];
    for (const phaseOptions of phases) {
      delivered = signalTracked(tracked, "SIGTERM", phaseOptions) || delivered;
      let phaseLive = await pollTracked(tracked, phaseOptions, options.termPollAttempts ?? 11);
      if (phaseLive.length > 0) {
        escalated = true;
        delivered = signalTracked(tracked, "SIGKILL", phaseOptions) || delivered;
        phaseLive = await pollTracked(tracked, phaseOptions, options.killPollAttempts ?? 11);
      }
      live = phaseLive;
    }

    return {
      attempted: true,
      delivered,
      verified: live.length === 0,
      escalated,
      method: "process-tree",
      // The algorithm covers same-process-group descendants plus those observed at scan time.
      // A post-scan setsid descendant can escape the tracked process tree.
      targets: [...tracked.values()].sort((left, right) => right.depth - left.depth).map((record) => record.pid),
      survivors: live.map((record) => record.pid)
    };
  } catch (error) {
    if (error?.code !== "PROCESS_TABLE_UNAVAILABLE") {
      throw error;
    }
    return degradedDirectChildKill(pid, options, killImpl, error.message);
  }
}

export async function terminateProcessGroup(pgid, options = {}) {
  if (!Number.isFinite(pgid)) {
    return { attempted: false, delivered: false, verified: true, survivors: [] };
  }
  if ((options.platform ?? process.platform) === "win32") {
    return { attempted: false, delivered: false, verified: true, survivors: [] };
  }

  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  let processes;
  try {
    processes = readUnixProcessTable(runCommandImpl, options);
  } catch (error) {
    if (error?.code !== "PROCESS_TABLE_UNAVAILABLE") {
      throw error;
    }
    warnProcessCleanup(
      `Unable to enumerate Unix processes while reclaiming process group ${pgid}; surviving PIDs unknown.`,
      options
    );
    return { attempted: false, delivered: false, verified: false, degraded: true, survivors: [] };
  }

  const tracked = new Map();
  for (const record of processes.values()) {
    if (record.processGroupId === pgid && isRunningProcess(record)) {
      tracked.set(record.identity, record);
    }
  }
  if (tracked.size === 0) {
    return { attempted: false, delivered: false, verified: true, survivors: [] };
  }

  const unixOptions = {
    runCommandImpl,
    killImpl,
    cwd: options.cwd,
    env: options.env,
    sleepImpl: options.sleepImpl ?? sleep,
    pollIntervalMs: options.pollIntervalMs ?? 25
  };

  try {
    let delivered = signalTracked(tracked, "SIGTERM", unixOptions);
    let live = await pollTracked(tracked, unixOptions, options.termPollAttempts ?? 11);
    let escalated = false;
    if (live.length > 0) {
      escalated = true;
      delivered = signalTracked(tracked, "SIGKILL", unixOptions) || delivered;
      live = await pollTracked(tracked, unixOptions, options.killPollAttempts ?? 11);
    }
    return {
      attempted: true,
      delivered,
      verified: live.length === 0,
      escalated,
      method: "process-group",
      targets: [...tracked.values()].map((record) => record.pid),
      survivors: live.map((record) => record.pid)
    };
  } catch (error) {
    if (error?.code !== "PROCESS_TABLE_UNAVAILABLE") {
      throw error;
    }
    warnProcessCleanup(
      `Unable to verify Unix process-group cleanup for pgid ${pgid}; surviving PIDs unknown.`,
      options
    );
    return { attempted: true, delivered: true, verified: false, degraded: true, survivors: [] };
  }
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
