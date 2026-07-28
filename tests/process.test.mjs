import test from "node:test";
import assert from "node:assert/strict";

import { getLiveProcessPids, terminateProcessGroup, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", async () => {
  let captured = null;
  const outcome = await terminateProcessTree(1234, {
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

test("getLiveProcessPids ignores a survivor PID reused by a different process", () => {
  const live = getLiveProcessPids([900], {
    platform: "darwin",
    identities: ["900@old"],
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "900 1 900 S Mon Jul 27 00:00:02 2026\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.deepEqual(live, []);
});

test("terminateProcessTree treats missing Windows processes as already stopped", async () => {
  const outcome = await terminateProcessTree(1234, {
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

test("terminateProcessTree terminates Unix descendant groups deepest-first", async () => {
  const signals = [];
  const alive = new Set([1234, 1235, 1236, 1237]);
  const parents = new Map([[1234, 1], [1235, 1234], [1236, 1235], [1237, 1234]]);
  const outcome = await terminateProcessTree(1234, {
    platform: "darwin",
    expectedRootIdentity: "1234@Mon Jul 27 00:00:00 2026",
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

test("terminateProcessTree signals a Unix PID directly when it is not a group leader", async () => {
  const signals = [];
  let alive = true;
  const outcome = await terminateProcessTree(1234, {
    platform: "darwin",
    expectedRootIdentity: "1234@Mon Jul 27 00:00:00 2026",
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

test("terminateProcessTree parses a captured Linux procps process table", async () => {
  const signals = [];
  const alive = new Set([42001, 42002]);
  const sample = [
    "42001       1 42001 Ss   Mon Jul 27 12:34:56 2026",
    "42002   42001 42002 S    Mon Jul 27 12:34:57 2026"
  ].join("\n");
  const outcome = await terminateProcessTree(42001, {
    platform: "linux",
    expectedRootIdentity: "42001@Mon Jul 27 12:34:56 2026",
    runCommandImpl(command, args) {
      assert.equal(command, "/bin/ps");
      assert.deepEqual(args, ["-axo", "pid=,ppid=,pgid=,stat=,lstart="]);
      const stdout = [...alive]
        .map((pid) => sample.split("\n").find((line) => line.startsWith(String(pid))))
        .filter(Boolean)
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

  assert.deepEqual(signals, [[-42002, "SIGTERM"], [-42001, "SIGTERM"]]);
  assert.equal(outcome.verified, true);
  assert.deepEqual(outcome.targets, [42002, 42001]);
});

test("terminateProcessTree falls back to a direct child kill when Unix process enumeration fails", async () => {
  const signals = [];
  const warnings = [];
  const outcome = await terminateProcessTree(1234, {
    platform: "darwin",
    expectedRootIdentity: "1234@Mon Jul 27 00:00:00 2026",
    warnImpl(message) {
      warnings.push(message);
    },
    runCommandImpl(command, args) {
      assert.equal(command, "/bin/ps");
      assert.deepEqual(args, ["-axo", "pid=,ppid=,pgid=,stat=,lstart="]);
      return {
        command,
        args,
        status: 1,
        signal: null,
        stdout: "",
        stderr: "ps denied",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
    }
  });

  assert.deepEqual(signals, [[1234, "SIGKILL"]]);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
  assert.deepEqual(outcome.survivors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /direct-child kill fallback.*none known/i);
});

test("terminateProcessTree refuses a reused root PID", async () => {
  const signals = [];
  const outcome = await terminateProcessTree(1234, {
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
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.identityMismatch, true);
  const ownershipSnapshot = {
    rootPid: 1234,
    rootIdentity: "1234@Mon Jul 27 00:00:00 2026",
    processGroupId: 1234,
    members: [
      {
        pid: 1234,
        parentPid: 1,
        processGroupId: 1234,
        state: "S",
        startedAt: "Mon Jul 27 00:00:00 2026",
        identity: "1234@Mon Jul 27 00:00:00 2026",
        depth: 0
      },
      {
        pid: 1235,
        parentPid: 1234,
        processGroupId: 1235,
        state: "S",
        startedAt: "Mon Jul 27 00:00:01 2026",
        identity: "1235@Mon Jul 27 00:00:01 2026",
        depth: 1
      }
    ]
  };
  const cleanOutcome = await terminateProcessTree(1234, {
    platform: "darwin",
    ownershipSnapshot,
    runCommandImpl(command, args) {
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
      throw new Error("no process should be signaled");
    }
  });

  assert.equal(cleanOutcome.verified, true);
  assert.equal(cleanOutcome.degraded, false);
  assert.deepEqual(cleanOutcome.survivors, []);
  assert.deepEqual(cleanOutcome.survivorIdentities, []);
});

test("terminateProcessTree refuses a PID without persisted ownership", async () => {
  const signals = [];
  const outcome = await terminateProcessTree(1234, {
    platform: "darwin",
    runCommandImpl() {
      return {
        command: "/bin/ps",
        args: [],
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
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
  assert.deepEqual(outcome.survivors, [1234]);
  assert.deepEqual(outcome.survivorIdentities, []);
});

test("terminateProcessTree refuses an absent PID without persisted ownership", async () => {
  const outcome = await terminateProcessTree(1234, {
    platform: "darwin",
    runCommandImpl(command, args) {
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
      throw new Error("a PID without persisted ownership must not be signaled");
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
  assert.deepEqual(outcome.survivors, [1234]);
  assert.deepEqual(outcome.survivorIdentities, []);
});

test("terminateProcessTree refuses capture-failure cleanup without a live owner handle", async () => {
  const identityObservedAtSpawn = "1234@Sun Jul 26 00:00:00 2026";
  const identityNowHoldingPid = "1234@Mon Jul 27 00:00:00 2026";
  const persistedRecord = {
    ownershipCaptureFailed: true,
    processIdentity: null,
    ownershipSnapshot: null
  };
  const signals = [];
  const outcome = await terminateProcessTree(1234, {
    platform: "darwin",
    expectedRootIdentity: persistedRecord.processIdentity,
    ownershipSnapshot: persistedRecord.ownershipSnapshot,
    requireVerifiedOwnership: persistedRecord.ownershipCaptureFailed,
    runCommandImpl() {
      return {
        command: "/bin/ps",
        args: [],
        status: 0,
        signal: null,
        stdout: `1234 1 1234 S ${identityNowHoldingPid.slice(identityNowHoldingPid.indexOf("@") + 1)}\n`,
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
    }
  });

  assert.notEqual(identityNowHoldingPid, identityObservedAtSpawn);
  assert.deepEqual(signals, []);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
});

test("terminateProcessTree permits capture-failure cleanup with a live owner handle", async () => {
  const identityObservedAtSpawn = "1234@Sun Jul 26 00:00:00 2026";
  const identityNowHoldingPid = "1234@Mon Jul 27 00:00:00 2026";
  const persistedRecord = {
    ownershipCaptureFailed: true,
    processIdentity: null,
    ownershipSnapshot: null
  };
  const signals = [];
  let alive = true;
  const outcome = await terminateProcessTree(1234, {
    platform: "darwin",
    expectedRootIdentity: persistedRecord.processIdentity,
    ownershipSnapshot: persistedRecord.ownershipSnapshot,
    requireVerifiedOwnership: persistedRecord.ownershipCaptureFailed,
    ownerHoldsLiveHandle: true,
    pollIntervalMs: 0,
    runCommandImpl() {
      return {
        command: "/bin/ps",
        args: [],
        status: 0,
        signal: null,
        stdout: alive
          ? `1234 1 1234 S ${identityNowHoldingPid.slice(identityNowHoldingPid.indexOf("@") + 1)}\n`
          : "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      alive = false;
    }
  });

  assert.notEqual(identityNowHoldingPid, identityObservedAtSpawn);
  assert.deepEqual(signals, [[-1234, "SIGTERM"]]);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
});

test("terminateProcessTree revalidates descendant identities before signaling", async () => {
  const signals = [];
  let rootAlive = true;
  let snapshots = 0;
  const outcome = await terminateProcessTree(1234, {
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

test("terminateProcessTree escalates resistant descendants and verifies exit", async () => {
  const signals = [];
  const alive = new Set([1234, 1235]);
  const pgids = new Map([[1234, 1234], [1235, 1235]]);
  const outcome = await terminateProcessTree(1234, {
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
    [-1235, "SIGKILL"],
    [-1234, "SIGTERM"],
    [-1234, "SIGKILL"]
  ]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.escalated, true);
});

test("terminateProcessTree keeps the root alive until its descendants are reaped", async () => {
  const signals = [];
  const alive = new Set([100, 200]);
  const outcome = await terminateProcessTree(100, {
    platform: "darwin",
    expectedRootIdentity: "100@Mon Jul 27 00:00:00 2026",
    pollIntervalMs: 0,
    runCommandImpl(command, args) {
      const rows = [];
      if (alive.has(100)) {
        rows.push("100 1 100 S Mon Jul 27 00:00:00 2026");
      }
      if (alive.has(200)) {
        rows.push("200 100 200 S Mon Jul 27 00:00:01 2026");
      }
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: rows.length ? `${rows.join("\n")}\n` : "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      // The helper resists SIGTERM so the descendant phase must escalate
      // before the root may be signaled at all.
      if (Math.abs(pid) === 200 && signal === "SIGTERM") {
        return;
      }
      alive.delete(Math.abs(pid));
    }
  });

  assert.deepEqual(signals, [
    [-200, "SIGTERM"],
    [-200, "SIGKILL"],
    [-100, "SIGTERM"]
  ]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.escalated, true);
});

test("terminateProcessTree tracks reparented members of a signaled process group", async () => {
  async function runScenario(helperSurvivesKill) {
    const signals = [];
    const alive = new Set([100, 200]);
    const outcome = await terminateProcessTree(100, {
      platform: "darwin",
      expectedRootIdentity: "100@Mon Jul 27 00:00:00 2026",
      termPollAttempts: 1,
      killPollAttempts: 1,
      sleepImpl() {},
      runCommandImpl(command, args) {
        const rows = [];
        if (alive.has(100)) {
          rows.push("100 1 100 S Mon Jul 27 00:00:00 2026");
        }
        if (alive.has(200)) {
          rows.push("200 1 100 S Mon Jul 27 00:00:01 2026");
        }
        return {
          command,
          args,
          status: 0,
          signal: null,
          stdout: rows.length ? `${rows.join("\n")}\n` : "",
          stderr: "",
          error: null
        };
      },
      killImpl(pid, signal) {
        signals.push([pid, signal]);
        if (signal === "SIGTERM") {
          alive.delete(100);
        } else if (!helperSurvivesKill) {
          alive.delete(200);
        }
      }
    });

    assert.deepEqual(signals, [[-100, "SIGTERM"], [200, "SIGKILL"]]);
    assert.equal(outcome.escalated, true);
    assert.equal(outcome.verified, !helperSurvivesKill);
    assert.deepEqual(outcome.survivors, helperSurvivesKill ? [200] : []);
  }

  await runScenario(false);
  await runScenario(true);
});

test("terminateProcessGroup reclaims orphaned members of a dead leader's group", async () => {
  const signals = [];
  const alive = new Set([202]);
  const outcome = await terminateProcessGroup(200, {
    platform: "darwin",
    pollIntervalMs: 0,
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: alive.has(202) ? "202 1 200 S Mon Jul 27 00:00:02 2026\n" : "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      alive.delete(Math.abs(pid));
    }
  });

  assert.deepEqual(signals, [[202, "SIGTERM"]]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.method, "process-group");
  assert.deepEqual(outcome.targets, [202]);
});

test("terminateProcessGroup hunts an observed regrouped helper after its root exits", async () => {
  const signals = [];
  const alive = new Set([200]);
  const ownershipSnapshot = {
    rootPid: 100,
    rootIdentity: "100@Mon Jul 27 00:00:00 2026",
    processGroupId: 100,
    members: [
      {
        pid: 100,
        parentPid: 1,
        processGroupId: 100,
        state: "S",
        startedAt: "Mon Jul 27 00:00:00 2026",
        identity: "100@Mon Jul 27 00:00:00 2026",
        depth: 0
      },
      {
        pid: 200,
        parentPid: 100,
        processGroupId: 200,
        state: "S",
        startedAt: "Mon Jul 27 00:00:01 2026",
        identity: "200@Mon Jul 27 00:00:01 2026",
        depth: 1
      }
    ]
  };
  const outcome = await terminateProcessGroup(100, {
    platform: "darwin",
    ownershipSnapshot,
    pollIntervalMs: 0,
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: alive.has(200) ? "200 1 200 S Mon Jul 27 00:00:01 2026\n" : "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      alive.delete(Math.abs(pid));
    }
  });

  assert.deepEqual(signals, [[-200, "SIGTERM"]]);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
  assert.deepEqual(outcome.survivors, []);
});

test("terminateProcessGroup excludes a reused snapshot PID", async () => {
  const signals = [];
  const ownershipSnapshot = {
    rootPid: 100,
    rootIdentity: "100@Mon Jul 27 00:00:00 2026",
    processGroupId: 100,
    members: [
      {
        pid: 100,
        parentPid: 1,
        processGroupId: 100,
        state: "S",
        startedAt: "Mon Jul 27 00:00:00 2026",
        identity: "100@Mon Jul 27 00:00:00 2026",
        depth: 0
      },
      {
        pid: 200,
        parentPid: 100,
        processGroupId: 100,
        state: "S",
        startedAt: "Mon Jul 27 00:00:01 2026",
        identity: "200@Mon Jul 27 00:00:01 2026",
        depth: 1
      }
    ]
  };
  const outcome = await terminateProcessGroup(100, {
    platform: "darwin",
    ownershipSnapshot,
    pollIntervalMs: 0,
    runCommandImpl() {
      return {
        command: "/bin/ps",
        args: [],
        status: 0,
        signal: null,
        stdout: "200 1 100 S Mon Jul 27 00:01:01 2026\n",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
    }
  });

  assert.deepEqual(signals, []);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
});

test("terminateProcessGroup reclaims a post-snapshot member of the owned group", async () => {
  const signals = [];
  let alive = true;
  const ownershipSnapshot = {
    rootPid: 100,
    rootIdentity: "100@Mon Jul 27 00:00:00 2026",
    processGroupId: 100,
    members: [
      {
        pid: 100,
        parentPid: 1,
        processGroupId: 100,
        state: "S",
        startedAt: "Mon Jul 27 00:00:00 2026",
        identity: "100@Mon Jul 27 00:00:00 2026",
        depth: 0
      }
    ]
  };
  const outcome = await terminateProcessGroup(100, {
    platform: "darwin",
    ownershipSnapshot,
    pollIntervalMs: 0,
    runCommandImpl() {
      return {
        command: "/bin/ps",
        args: [],
        status: 0,
        signal: null,
        stdout: alive ? "300 1 100 S Mon Jul 27 00:00:02 2026\n" : "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      alive = false;
    }
  });

  assert.deepEqual(signals, [[300, "SIGTERM"]]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.degraded, false);
  assert.deepEqual(outcome.survivors, []);
});

test("terminateProcessGroup signals nothing when the group id was reused by another leader", async () => {
  const signals = [];
  const ownershipSnapshot = {
    rootPid: 100,
    rootIdentity: "100@Mon Jul 27 00:00:00 2026",
    processGroupId: 100,
    members: [
      {
        pid: 100,
        parentPid: 1,
        processGroupId: 100,
        state: "S",
        startedAt: "Mon Jul 27 00:00:00 2026",
        identity: "100@Mon Jul 27 00:00:00 2026",
        depth: 0
      }
    ]
  };
  // pid 100 now belongs to an unrelated process that leads its own group, and
  // pid 301 is a member of that stranger's group. 301 is absent from the
  // snapshot, so the per-record check cannot exclude it.
  const outcome = await terminateProcessGroup(100, {
    platform: "darwin",
    ownershipSnapshot,
    pollIntervalMs: 0,
    runCommandImpl() {
      return {
        command: "/bin/ps",
        args: [],
        status: 0,
        signal: null,
        stdout:
          "100 1 100 S Tue Jul 28 09:00:00 2026\n301 100 100 S Tue Jul 28 09:00:01 2026\n",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      signals.push([pid, signal]);
    }
  });

  assert.deepEqual(signals, []);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
  assert.deepEqual(outcome.survivors, [100]);
});
