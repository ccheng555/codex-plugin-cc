import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree terminates Unix descendant groups deepest-first", () => {
  const signals = [];
  const alive = new Set([1234, 1235, 1236, 1237]);
  const parents = new Map([[1234, 1], [1235, 1234], [1236, 1235], [1237, 1234]]);
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    runCommandImpl(command, args) {
      assert.equal(command, "/bin/ps");
      assert.deepEqual(args, ["-axo", "pid=,ppid=,pgid=,stat=,lstart="]);
      const stdout = [...alive]
        .map((pid) => `${pid} ${parents.get(pid)} ${pid} S Mon Jul 27 00:00:0${pid - 1234} 2026`)
        .join("\n");
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: stdout ? `${stdout}\n` : "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      alive.delete(Math.abs(pid));
    }
  });

  assert.deepEqual(signals, [
    [-1236, "SIGTERM"],
    [-1235, "SIGTERM"],
    [-1237, "SIGTERM"],
    [-1234, "SIGTERM"]
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process-tree");
  assert.deepEqual(outcome.targets, [1236, 1235, 1237, 1234]);
});

test("terminateProcessTree signals a Unix PID directly when it is not a group leader", () => {
  const signals = [];
  let alive = true;
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: alive ? "1234 1 999 S Mon Jul 27 00:00:00 2026\n" : "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      alive = false;
    }
  });

  assert.deepEqual(signals, [[1234, "SIGTERM"]]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.method, "process-tree");
});

test("terminateProcessTree fails closed when Unix process enumeration fails", () => {
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: "darwin",
        runCommandImpl(command, args) {
          return {
            command,
            args,
            status: 1,
            signal: null,
            stdout: "",
            stderr: "ps denied",
            error: null
          };
        }
      }),
    /Unable to enumerate Unix processes.*ps denied/i
  );
});

test("terminateProcessTree refuses a reused root PID", () => {
  const signals = [];
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    expectedRootIdentity: "1234@Sun Jul 26 00:00:00 2026",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "1234 1 1234 S Mon Jul 27 00:00:00 2026\n",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
    }
  });

  assert.deepEqual(signals, []);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.identityMismatch, true);
});

test("terminateProcessTree revalidates descendant identities before signaling", () => {
  const signals = [];
  let rootAlive = true;
  let snapshots = 0;
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    expectedRootIdentity: "1234@Mon Jul 27 00:00:00 2026",
    termPollAttempts: 1,
    killPollAttempts: 1,
    sleepImpl() {},
    runCommandImpl(command, args) {
      snapshots += 1;
      const root = rootAlive ? "1234 1 1234 S Mon Jul 27 00:00:00 2026\n" : "";
      const childStart = snapshots === 1 ? "Mon Jul 27 00:00:01 2026" : "Mon Jul 27 00:01:01 2026";
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: `${root}1235 1234 1235 S ${childStart}\n`,
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      if (pid === -1234) {
        rootAlive = false;
      }
    }
  });

  assert.deepEqual(signals, [[-1234, "SIGTERM"]]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.escalated, false);
});

test("terminateProcessTree escalates resistant descendants and verifies exit", () => {
  const signals = [];
  const alive = new Set([1234, 1235]);
  const pgids = new Map([[1234, 1234], [1235, 1235]]);
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    expectedRootIdentity: "1234@Mon Jul 27 00:00:00 2026",
    termPollAttempts: 1,
    killPollAttempts: 1,
    sleepImpl() {},
    runCommandImpl(command, args) {
      const stdout = [
        alive.has(1234) ? "1234 1 1234 S Mon Jul 27 00:00:00 2026" : null,
        alive.has(1235) ? "1235 1234 1235 S Mon Jul 27 00:00:01 2026" : null
      ].filter(Boolean).join("\n");
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: stdout ? `${stdout}\n` : "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      if (signal !== "SIGKILL") {
        return;
      }
      const targetPgid = pid < 0 ? -pid : pgids.get(pid);
      for (const candidate of [...alive]) {
        if (candidate === pid || pgids.get(candidate) === targetPgid) {
          alive.delete(candidate);
        }
      }
    }
  });

  assert.deepEqual(signals, [
    [-1235, "SIGTERM"],
    [-1234, "SIGTERM"],
    [-1235, "SIGKILL"],
    [-1234, "SIGKILL"]
  ]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.escalated, true);
});
