import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireBrokerRegistryLock,
  assessBrokerOwners,
  loadBrokerChildren,
  publishBrokerChild,
  publishBrokerRegistration,
  registerBrokerOwner,
  releaseBrokerChild,
  releaseBrokerOwner,
  releaseBrokerRegistryLock
} from "../plugins/codex/scripts/lib/broker-ownership.mjs";

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-ownership-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { CLAUDE_PLUGIN_DATA: root };
  const brokerIdentity = "4100@Mon Jul 27 00:00:00 2026";
  const ownershipSnapshot = {
    rootPid: 4100,
    rootIdentity: brokerIdentity,
    processGroupId: 4100,
    members: [
      {
        pid: 4100,
        parentPid: 1,
        processGroupId: 4100,
        state: "S",
        startedAt: "Mon Jul 27 00:00:00 2026",
        identity: brokerIdentity,
        depth: 0
      }
    ]
  };
  const registration = publishBrokerRegistration({
    cwd: root,
    endpoint: `unix:${path.join(root, "broker.sock")}`,
    pid: 4100,
    ownershipSnapshot,
    env,
    now: () => "2026-07-27T00:00:00.000Z"
  });
  assert.equal(registration.registered, true);
  return { root, env, registration };
}

function ownerEnv(env, sessionId, pid, startedAt) {
  return {
    ...env,
    CODEX_COMPANION_SESSION_ID: sessionId,
    CODEX_COMPANION_SESSION_OWNER_PID: String(pid),
    CODEX_COMPANION_SESSION_OWNER_IDENTITY: `${pid}@${startedAt}`
  };
}

test("owner publication fails closed while cleanup holds the registry lock", (t) => {
  const { registration, env } = makeFixture(t);
  const lock = acquireBrokerRegistryLock(registration, {
    pid: 5000,
    now: () => "2026-07-27T00:00:30.000Z"
  });
  assert.equal(lock.acquired, true);
  assert.equal(fs.statSync(lock.path).mode & 0o777, 0o700);

  const blocked = registerBrokerOwner(
    registration,
    {
      env: ownerEnv(env, "session-racing", 5050, "Mon Jul 27 00:00:45 2026"),
      getLiveProcessPidsImpl: () => [5000]
    }
  );
  assert.deepEqual(blocked, { registered: false, reason: "registry-busy" });

  assert.deepEqual(releaseBrokerRegistryLock(registration, lock), { released: true });
  const registered = registerBrokerOwner(
    registration,
    { env: ownerEnv(env, "session-racing", 5050, "Mon Jul 27 00:00:45 2026") }
  );
  assert.equal(registered.registered, true);
});

test("a well-formed lock whose creator is absent is quarantined before retry", (t) => {
  const { registration, env } = makeFixture(t);
  const stale = acquireBrokerRegistryLock(registration, {
    pid: 5001,
    now: () => "2026-07-27T00:00:31.000Z"
  });
  assert.equal(stale.acquired, true);

  const registered = registerBrokerOwner(registration, {
    env: ownerEnv(env, "session-after-stale-lock", 5051, "Mon Jul 27 00:00:46 2026"),
    getLiveProcessPidsImpl: () => []
  });
  assert.equal(registered.registered, true);
  const staleRoot = path.join(registration.registryDir, "stale-locks");
  assert.equal(fs.readdirSync(staleRoot).length, 1);
  assert.equal(fs.existsSync(stale.path), false);
});

test("registered broker with a live owner is not eligible for cleanup", (t) => {
  const { registration, env } = makeFixture(t);
  const liveOwner = ownerEnv(env, "session-live", 5100, "Mon Jul 27 00:01:00 2026");
  const owner = registerBrokerOwner(registration, { env: liveOwner, now: () => "2026-07-27T00:01:00.000Z" });

  const assessment = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl(pids, options) {
      assert.deepEqual(pids, [5100]);
      assert.deepEqual(options.identities, ["5100@Mon Jul 27 00:01:00 2026"]);
      return [5100];
    }
  });

  assert.equal(owner.registered, true);
  assert.equal(assessment.safeToShutdown, false);
  assert.equal(assessment.reason, "live-owner");
  assert.deepEqual(assessment.liveOwners.map((candidate) => candidate.sessionId), ["session-live"]);
  assert.equal(fs.statSync(owner.path).mode & 0o777, 0o600);
});

test("registered broker is eligible only after every owner is dead or released", (t) => {
  const { registration, env } = makeFixture(t);
  const ownerA = ownerEnv(env, "session-a", 5200, "Mon Jul 27 00:02:00 2026");
  const ownerB = ownerEnv(env, "session-b", 5300, "Mon Jul 27 00:03:00 2026");
  registerBrokerOwner(registration, { env: ownerA });
  registerBrokerOwner(registration, { env: ownerB });

  const mixed = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl(pids) {
      return pids[0] === 5300 ? [5300] : [];
    }
  });
  assert.equal(mixed.safeToShutdown, false);
  assert.deepEqual(mixed.liveOwners.map((candidate) => candidate.sessionId), ["session-b"]);

  releaseBrokerOwner(registration, { env: ownerB, now: () => "2026-07-27T00:04:00.000Z" });
  const released = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl() {
      return [];
    }
  });
  assert.equal(released.safeToShutdown, true);
  assert.equal(released.reason, "all-owners-dead-or-released");
  assert.deepEqual(released.releasedOwners.map((candidate) => candidate.sessionId), ["session-b"]);
});

test("owner PID reuse with a different identity does not keep a broker alive", (t) => {
  const { registration, env } = makeFixture(t);
  registerBrokerOwner(registration, {
    env: ownerEnv(env, "session-reused", 5400, "Mon Jul 27 00:05:00 2026")
  });

  const assessment = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl() {
      return [];
    }
  });
  assert.equal(assessment.safeToShutdown, true);
  assert.deepEqual(assessment.deadOwners.map((candidate) => candidate.sessionId), ["session-reused"]);
});

test("malformed owner state blocks cleanup instead of being skipped", (t) => {
  const { registration } = makeFixture(t);
  const ownersDir = path.join(registration.registryDir, "owners");
  fs.mkdirSync(ownersDir, { recursive: true });
  fs.writeFileSync(path.join(ownersDir, "malformed.json"), "{not-json\n", { mode: 0o600 });

  const assessment = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl() {
      throw new Error("malformed rows must stop before liveness checks");
    }
  });
  assert.equal(assessment.safeToShutdown, false);
  assert.equal(assessment.reason, "malformed-registry");
  assert.equal(assessment.malformed.length, 1);
});

test("symlinked or overly permissive registry rows block cleanup", (t) => {
  const permissiveFixture = makeFixture(t);
  const registered = registerBrokerOwner(permissiveFixture.registration, {
    env: ownerEnv(permissiveFixture.env, "session-permissive", 5450, "Mon Jul 27 00:05:30 2026")
  });
  fs.chmodSync(registered.path, 0o644);
  const permissive = assessBrokerOwners(permissiveFixture.registration, {
    getLiveProcessPidsImpl: () => []
  });
  assert.equal(permissive.safeToShutdown, false);
  assert.equal(permissive.reason, "malformed-registry");

  const symlinkFixture = makeFixture(t);
  const ownersDir = path.join(symlinkFixture.registration.registryDir, "owners");
  fs.mkdirSync(ownersDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(ownersDir, 0o700);
  const target = path.join(symlinkFixture.root, "outside.json");
  fs.writeFileSync(target, "{}\n", { mode: 0o600 });
  fs.symlinkSync(target, path.join(ownersDir, "linked.json"));
  const symlinked = assessBrokerOwners(symlinkFixture.registration, {
    getLiveProcessPidsImpl: () => []
  });
  assert.equal(symlinked.safeToShutdown, false);
  assert.equal(symlinked.reason, "malformed-registry");
});

test("a broker record with no owner rows remains unregistered and report-only", (t) => {
  const { registration } = makeFixture(t);
  const assessment = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl() {
      throw new Error("an ownerless broker must not reach liveness checks");
    }
  });
  assert.equal(assessment.safeToShutdown, false);
  assert.equal(assessment.reason, "no-registered-owner");
});

test("broker child ownership is immutable and identity keyed", (t) => {
  const { registration } = makeFixture(t);
  const childSnapshot = {
    rootPid: 6100,
    rootIdentity: "6100@Mon Jul 27 00:06:00 2026",
    processGroupId: 6100,
    members: [
      {
        pid: 6100,
        parentPid: 4100,
        processGroupId: 6100,
        state: "S",
        startedAt: "Mon Jul 27 00:06:00 2026",
        identity: "6100@Mon Jul 27 00:06:00 2026",
        depth: 0
      }
    ]
  };
  const first = publishBrokerChild(registration, {
    ownershipSnapshot: childSnapshot,
    now: () => "2026-07-27T00:06:00.000Z"
  });
  const second = publishBrokerChild(registration, {
    ownershipSnapshot: childSnapshot,
    now: () => "2026-07-27T00:06:00.000Z"
  });

  assert.equal(first.registered, true);
  assert.equal(second.path, first.path);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.path, "utf8")).ownershipSnapshot, childSnapshot);

  const refused = releaseBrokerChild(registration, {
    child: first.child,
    cleanupOutcome: { verified: false, survivors: [6100] }
  });
  assert.equal(refused.released, false);
  assert.equal(loadBrokerChildren(registration).children.length, 1);

  const released = releaseBrokerChild(registration, {
    child: first.child,
    cleanupOutcome: { verified: true, survivors: [], survivorIdentities: [] },
    now: () => "2026-07-27T00:07:00.000Z"
  });
  assert.equal(released.released, true);
  assert.equal(fs.statSync(released.path).mode & 0o777, 0o600);
  const children = loadBrokerChildren(registration);
  assert.equal(children.children.length, 0);
  assert.equal(children.releasedChildren.length, 1);
});
