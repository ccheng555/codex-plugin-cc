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
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    runCommandImpl(command, args) {
      assert.equal(command, "ps");
      assert.deepEqual(args, ["-axo", "pid=,ppid="]);
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "1234 1\n1235 1234\n1236 1235\n1237 1234\n",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
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

test("terminateProcessTree falls back to a Unix PID when it is not a group leader", () => {
  const signals = [];
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "1234 1\n",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("no such process group");
        error.code = "ESRCH";
        throw error;
      }
    }
  });

  assert.deepEqual(signals, [[-1234, "SIGTERM"], [1234, "SIGTERM"]]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process-tree");
});
