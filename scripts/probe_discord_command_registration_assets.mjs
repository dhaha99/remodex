import fs from "node:fs/promises";
import path from "node:path";
import { buildDiscordCommandManifest } from "./lib/discord_command_manifest.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(
  verificationDir,
  "discord_command_registration_assets_probe_summary.json",
);

function commandEndpoint({ apiBaseUrl, applicationId, guildId = null }) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  if (guildId) {
    return `${base}/applications/${applicationId}/guilds/${guildId}/commands`;
  }
  return `${base}/applications/${applicationId}/commands`;
}

const summary = {
  startedAt: new Date().toISOString(),
};

try {
  await fs.mkdir(verificationDir, { recursive: true });
  const manifest = buildDiscordCommandManifest();
  const endpoint = commandEndpoint({
    apiBaseUrl: "https://discord.com/api/v10",
    applicationId: "app-123",
    guildId: "guild-123",
  });

  summary.command_names = manifest.map((command) => command.name);
  summary.endpoint = endpoint;
  summary.status_project_optional = manifest.find((command) => command.name === "status")?.options?.find((option) => option.name === "project")?.required === false;
  summary.status_project_autocomplete = Boolean(
    manifest.find((command) => command.name === "status")?.options?.find((option) => option.name === "project")?.autocomplete,
  );
  summary.use_project_present = summary.command_names.includes("use-project");
  summary.projects_present = summary.command_names.includes("projects");
  summary.attach_thread_present = summary.command_names.includes("attach-thread");
  summary.background_on_present = summary.command_names.includes("background-on");
  summary.foreground_on_present = summary.command_names.includes("foreground-on");
  summary.attach_thread_required = Boolean(
    manifest.find((command) => command.name === "attach-thread")?.options?.find((option) => option.name === "thread_id")
      ?.required,
  );
  summary.attach_thread_autocomplete = Boolean(
    manifest.find((command) => command.name === "attach-thread")?.options?.find((option) => option.name === "thread_id")
      ?.autocomplete,
  );
  summary.reply_source_ref_required = Boolean(
    manifest.find((command) => command.name === "reply")?.options?.find((option) => option.name === "source_ref")?.required,
  );
  summary.approval_source_ref_required = Boolean(
    manifest.find((command) => command.name === "approve-candidate")?.options?.find((option) => option.name === "source_ref")?.required,
  );
  summary.use_project_autocomplete = Boolean(
    manifest.find((command) => command.name === "use-project")?.options?.find((option) => option.name === "project")?.autocomplete,
  );
  summary.background_on_project_optional = manifest.find((command) => command.name === "background-on")?.options?.find((option) => option.name === "project")?.required === false;
  summary.background_on_project_autocomplete = Boolean(
    manifest.find((command) => command.name === "background-on")?.options?.find((option) => option.name === "project")?.autocomplete,
  );
  summary.foreground_on_project_optional = manifest.find((command) => command.name === "foreground-on")?.options?.find((option) => option.name === "project")?.required === false;
  summary.foreground_on_project_autocomplete = Boolean(
    manifest.find((command) => command.name === "foreground-on")?.options?.find((option) => option.name === "project")?.autocomplete,
  );
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.command_names.join(",") === "projects,create-project,attach-thread,background-on,foreground-on,status,use-project,intent,reply,approve-candidate" &&
    endpoint === "https://discord.com/api/v10/applications/app-123/guilds/guild-123/commands" &&
    summary.projects_present &&
    summary.attach_thread_present &&
    summary.background_on_present &&
    summary.foreground_on_present &&
    summary.attach_thread_required &&
    summary.attach_thread_autocomplete &&
    summary.use_project_present &&
    summary.status_project_optional &&
    summary.status_project_autocomplete &&
    summary.use_project_autocomplete &&
    summary.background_on_project_optional &&
    summary.background_on_project_autocomplete &&
    summary.foreground_on_project_optional &&
    summary.foreground_on_project_autocomplete &&
    summary.reply_source_ref_required &&
    summary.approval_source_ref_required
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
}

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord command registration assets probe failed");
}
