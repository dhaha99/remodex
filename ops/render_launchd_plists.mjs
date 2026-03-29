import {
  DEFAULT_SCHEDULER_KIND,
  renderSchedulerArtifacts,
  resolveSchedulerRenderContext,
} from "./lib/scheduler_adapter.mjs";

const context = await resolveSchedulerRenderContext();
context.schedulerKind = DEFAULT_SCHEDULER_KIND;
const result = await renderSchedulerArtifacts(context);

console.log(JSON.stringify({
  deprecated_entrypoint: "ops/render_launchd_plists.mjs",
  ...result,
}, null, 2));
