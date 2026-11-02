import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import postgres from "postgres";

export const project = "fssrgbtlbuvgmnjfhrmx";
export const role = "p919_health_reader";
const marker = "projeto919-db-read-v1";
const transientCodes = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "53300",
  "57P03",
]);

function failureCategory(error) {
  if (transientCodes.has(error?.code)) return "connection";
  if (["28P01", "28000"].includes(error?.code)) return "authentication";
  if (["42501", "PERMISSIONS_REJECTED"].includes(error?.code))
    return "permissions";
  if (error?.code === "IDENTITY_REJECTED") return "identity";
  if (["42883", "3F000", "PROBE_REJECTED"].includes(error?.code))
    return "technical resource";
  if (
    [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].includes(error?.code)
  )
    return "TLS certificate";
  return "unclassified failure";
}

export function configuration(env) {
  const host = env.P919_DB_HOST;
  const password = env.P919_DB_PASSWORD;
  // Only the official project's shared pooler. No arbitrary URL, user or role.
  if (
    !/^aws-\d+-sa-east-1\.pooler\.supabase\.com$/.test(host ?? "") ||
    !password ||
    password.trim() !== password ||
    password.includes("\n") ||
    password.includes("\r")
  ) {
    throw Object.assign(new Error("Invalid configuration"), {
      code: "CONFIGURATION",
    });
  }
  return {
    host,
    port: 5432,
    database: "postgres",
    username: `${role}.${project}`,
    password,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(new URL("./supabase-ca.crt", import.meta.url), "utf8"),
    },
    max: 1,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 2,
    connection: { application_name: "projeto919-daily-read" },
    onnotice: () => {},
    debug: false,
  };
}

export async function query(db) {
  return db.begin("read only", async (tx) => {
    await tx`SET LOCAL statement_timeout = '15s'`;
    await tx`SET LOCAL lock_timeout = '3s'`;
    const [identity] = await tx`
      SELECT current_user AS role,
        current_setting('transaction_read_only') AS read_only,
        r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
          OR r.rolbypassrls AS privileged,
        EXISTS (SELECT 1 FROM pg_roles other
          WHERE other.oid <> r.oid AND pg_has_role(r.oid, other.oid, 'MEMBER'))
          AS member_of_other_role
      FROM pg_roles r WHERE r.rolname = current_user
    `;
    if (
      identity?.role !== role ||
      identity.read_only !== "on" ||
      identity.privileged ||
      identity.member_of_other_role
    ) {
      throw Object.assign(new Error("Identity rejected"), {
        code: "IDENTITY_REJECTED",
      });
    }
    // PUBLIC grants also apply to NOINHERIT roles. Fail closed on permission drift.
    const [access] = await tx`
      SELECT
        EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg_toast%'
            AND n.nspname NOT LIKE 'pg_temp_%'
            AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_schema_privilege(current_user, n.oid, 'USAGE')
            AND (has_any_column_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
              OR has_table_privilege(current_user, c.oid,
                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
        ) AS table_access,
        EXISTS (
          SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND has_schema_privilege(current_user, n.oid, 'USAGE')
            AND has_function_privilege(current_user, p.oid, 'EXECUTE')
        ) AS definer_access,
        EXISTS (
          SELECT 1 FROM pg_namespace n
          WHERE n.nspname NOT LIKE 'pg_temp_%'
            AND has_schema_privilege(current_user, n.oid, 'CREATE')
        ) AS schema_create
    `;
    if (access.table_access || access.definer_access || access.schema_create) {
      throw Object.assign(new Error("Permissions rejected"), {
        code: "PERMISSIONS_REJECTED",
      });
    }
    const rows = await tx`
      SELECT marker, checked_at FROM p919_health.probe()
    `;
    if (
      rows.length !== 1 ||
      rows[0].marker !== marker ||
      !Number.isFinite(new Date(rows[0].checked_at).getTime())
    ) {
      throw Object.assign(new Error("Unexpected probe result"), {
        code: "PROBE_REJECTED",
      });
    }
    return rows[0];
  });
}

export async function run(
  env,
  {
    connect = postgres,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console.log,
  } = {},
) {
  // Validate before opening any connection. Never load .env.local or admin URLs.
  const options = configuration(env);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const db = connect(options);
    try {
      await query(db);
      log(
        `OK: PostgreSQL read confirmed; project=${project}; attempt=${attempt}`,
      );
      return;
    } catch (error) {
      // Never print server messages, connection strings, passwords or raw errors.
      const retry = transientCodes.has(error?.code) && attempt < 3;
      log(
        `FAIL: ${failureCategory(error)}; ${retry ? "retrying" : "check rejected"}; attempt=${attempt}`,
      );
      if (!retry)
        throw new Error(
          "Database read check failed; inspect credentials and restricted-role permissions.",
        );
    } finally {
      await db.end({ timeout: 2 });
    }
    await sleep(attempt * 2000);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run(process.env).catch(() => {
    console.error(
      "::error::Projeto 919: database read failed. No credentials or server details logged.",
    );
    process.exitCode = 1;
  });
}
