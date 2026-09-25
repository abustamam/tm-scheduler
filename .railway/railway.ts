import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "sfo" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 5000 });
  const dbBackupVolume = volume("db-backup-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 5000 });
  const dbBackup = service("db-backup", {
    source: github("abustamam/tm-scheduler", { checkSuites: false, rootDirectory: "ops/backup" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    replicas: { "sfo": 1 },
    deploy: { cronSchedule: "17 9 * * *", restartPolicyType: "NEVER" },
    volumeMounts: { "/backups": dbBackupVolume },
    env: { DATABASE_URL: preserve() },
  });
  const gavelup = service("gavelup", {
    source: github("abustamam/tm-scheduler", { checkSuites: false }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/api/health",
    replicas: { "sfo": 1 },
    domains: ["gavelup.app"],
    networking: { privateNetworkEndpoint: "tm-scheduler" },
    env: { BETTER_AUTH_SECRET: preserve(), BETTER_AUTH_URL: preserve(), DATABASE_URL: preserve(), EMAIL_FROM: preserve(), RESEND_API_KEY: preserve(), SUPERADMIN_EMAILS: preserve() },
  });

  return project("tm-scheduler", {
    resources: [Postgres, dbBackup, gavelup, postgresVolume, dbBackupVolume],
  });
});
