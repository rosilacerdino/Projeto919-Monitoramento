import assert from "node:assert/strict";
import { test } from "node:test";
import { configuration, query, role, run } from "./check.mjs";

const env = {
  P919_DB_HOST: "aws-0-sa-east-1.pooler.supabase.com",
  P919_DB_PASSWORD: "test-only-password-not-a-real-secret",
};

function database({ identity = {}, access = {}, probe, failure } = {}) {
  const calls = [];
  let closed = 0;
  const tx = async (strings) => {
    const sql = strings.join("?");
    calls.push(sql);
    if (failure) throw failure;
    if (sql.includes("FROM pg_roles r"))
      return [
        {
          role,
          read_only: "on",
          privileged: false,
          member_of_other_role: false,
          ...identity,
        },
      ];
    if (sql.includes("AS table_access"))
      return [
        {
          table_access: false,
          definer_access: false,
          schema_create: false,
          ...access,
        },
      ];
    if (sql.includes("p919_health.probe()"))
      return (
        probe ?? [{ marker: "projeto919-db-read-v1", checked_at: new Date() }]
      );
    return [];
  };
  return {
    calls,
    get closed() {
      return closed;
    },
    async begin(mode, callback) {
      assert.equal(mode, "read only");
      return callback(tx);
    },
    async end() {
      closed++;
    },
  };
}

test("accepts only the official restricted pooler identity with verified TLS", () => {
  const config = configuration(env);
  assert.equal(config.username, "p919_health_reader.fssrgbtlbuvgmnjfhrmx");
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.ok(config.ssl.ca.includes("-----BEGIN CERTIFICATE-----"));
  assert.equal(config.prepare, false);
  for (const host of [
    "localhost",
    "db.vctmwjkjqnpsptnhzcwp.supabase.co",
    `${env.P919_DB_HOST}.evil.test`,
  ])
    assert.throws(() => configuration({ ...env, P919_DB_HOST: host }));
  assert.throws(() => configuration({ ...env, P919_DB_PASSWORD: "" }));
  assert.throws(() =>
    configuration({ ...env, P919_DB_PASSWORD: "bad\npassword" }),
  );
});

test("configuration failure opens no connection and does not read admin variables", async () => {
  let connections = 0;
  await assert.rejects(
    run(
      { DATABASE_URL: "never-use-admin-credentials" },
      {
        connect: () => {
          connections++;
        },
      },
    ),
  );
  assert.equal(connections, 0);
});

test("queries technical function in a read-only transaction, never user tables", async () => {
  const db = database();
  await query(db);
  assert.ok(db.calls.some((sql) => sql.includes("p919_health.probe()")));
  assert.ok(
    db.calls.every(
      (sql) =>
        !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE)\s+(?:INTO|TABLE|ROLE|SCHEMA|FUNCTION|ON|FROM)/i.test(
          sql,
        ),
    ),
  );
});

test("rejects wrong role, writable transaction, privileged roles and memberships", async () => {
  for (const identity of [
    { role: "postgres" },
    { read_only: "off" },
    { privileged: true },
    { member_of_other_role: true },
  ]) {
    const db = database({ identity });
    await assert.rejects(query(db), { code: "IDENTITY_REJECTED" });
    assert.ok(!db.calls.some((sql) => sql.includes("p919_health.probe()")));
  }
});

test("blocks permission drift before invoking the probe", async () => {
  for (const access of [
    { table_access: true },
    { definer_access: true },
    { schema_create: true },
  ]) {
    const db = database({ access });
    await assert.rejects(query(db), { code: "PERMISSIONS_REJECTED" });
    assert.ok(!db.calls.some((sql) => sql.includes("p919_health.probe()")));
  }
});

test("rejects missing, unexpected and malformed probe responses", async () => {
  for (const probe of [
    [],
    [{ marker: "wrong", checked_at: new Date() }],
    [{ marker: "projeto919-db-read-v1", checked_at: "bad-date" }],
  ])
    await assert.rejects(query(database({ probe })), {
      code: "PROBE_REJECTED",
    });
});

test("retries transient failures only and closes every connection", async () => {
  const failed = database({
    failure: { code: "ETIMEDOUT", message: env.P919_DB_PASSWORD },
  });
  const good = database();
  const logs = [];
  const sleeps = [];
  let connections = 0;
  await run(env, {
    connect: () => (connections++ === 0 ? failed : good),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => logs.push(line),
  });
  assert.equal(connections, 2);
  assert.equal(failed.closed, 1);
  assert.equal(good.closed, 1);
  assert.deepEqual(sleeps, [2000]);
  assert.ok(logs.at(-1).startsWith("OK:"));
  assert.ok(!logs.join().includes(env.P919_DB_PASSWORD));
});

test("does not retry authentication failures or expose raw error text", async () => {
  const db = database({
    failure: { code: "28P01", message: env.P919_DB_PASSWORD },
  });
  const logs = [];
  let connections = 0;
  await assert.rejects(
    run(env, {
      connect: () => {
        connections++;
        return db;
      },
      log: (line) => logs.push(line),
    }),
    (error) => !error.message.includes(env.P919_DB_PASSWORD),
  );
  assert.equal(connections, 1);
  assert.equal(db.closed, 1);
  assert.ok(logs[0].includes("authentication"));
  assert.ok(!logs.join().includes(env.P919_DB_PASSWORD));
});

test("stops after three transient failures", async () => {
  const databases = [];
  await assert.rejects(
    run(env, {
      connect: () => {
        const db = database({ failure: { code: "CONNECT_TIMEOUT" } });
        databases.push(db);
        return db;
      },
      sleep: async () => {},
      log: () => {},
    }),
  );
  assert.equal(databases.length, 3);
  assert.ok(databases.every((db) => db.closed === 1));
});
