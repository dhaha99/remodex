import {
  renderSchedulerArtifacts,
  resolveSchedulerRenderContext,
  SUPPORTED_SCHEDULER_KINDS,
} from "./lib/scheduler_adapter.mjs";

const context = await resolveSchedulerRenderContext();
const result = await renderSchedulerArtifacts(context);

console.log(JSON.stringify({
  supported_scheduler_kinds: SUPPORTED_SCHEDULER_KINDS,
  ...result,
}, null, 2));
