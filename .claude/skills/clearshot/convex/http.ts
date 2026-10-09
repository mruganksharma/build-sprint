import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/telemetry",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.json();
    const events = Array.isArray(body) ? body : [body];

    if (events.length > 100) {
      return new Response("Batch too large (max 100)", { status: 400 });
    }

    let inserted = 0;
    for (const event of events) {
      if (!event.ts || !event.version || !event.os || !event.outcome) continue;
      if (event.v !== 1) continue;

      await ctx.runMutation(internal.telemetry.insertEvent, {
        schema_version: event.v,
        event_timestamp: String(event.ts).slice(0, 30),
        skill_version: String(event.version).slice(0, 20),
        os: String(event.os).slice(0, 20),
        arch: event.arch ? String(event.arch).slice(0, 20) : undefined,
        duration_s: typeof event.duration_s === "number" ? event.duration_s : undefined,
        outcome: String(event.outcome).slice(0, 20),
        mode: event.mode ? String(event.mode).slice(0, 20) : undefined,
        steps_run: (event.levels_run || event.steps_run) ? String(event.levels_run || event.steps_run).slice(0, 20) : undefined,
        self_rating: typeof event.self_rating === "number" ? event.self_rating : undefined,
        installation_id: event.installation_id
          ? String(event.installation_id).slice(0, 64)
          : undefined,
      });
      inserted++;

      if (event.installation_id) {
        await ctx.runMutation(internal.telemetry.upsertInstallation, {
          installation_id: String(event.installation_id).slice(0, 64),
          skill_version: String(event.version).slice(0, 20),
          os: String(event.os).slice(0, 20),
        });
      }
    }

    return new Response(JSON.stringify({ inserted }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/feedback",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.json();

    if (!body.skill_version || body.self_rating === undefined || !body.why_not_10) {
      return new Response("Missing required fields", { status: 400 });
    }

    await ctx.runMutation(internal.feedback.insertReport, {
      submitted_at: new Date().toISOString(),
      skill_version: String(body.skill_version).slice(0, 20),
      self_rating: Number(body.self_rating),
      mode: String(body.mode || "unknown").slice(0, 20),
      steps_run: String(body.levels_run || body.steps_run || "").slice(0, 20),
      why_not_10: String(body.why_not_10).slice(0, 500),
      what_would_make_10: String(body.what_would_make_10 || "").slice(0, 500),
      os: body.os ? String(body.os).slice(0, 20) : undefined,
      installation_id: body.installation_id
        ? String(body.installation_id).slice(0, 64)
        : undefined,
    });

    return new Response(JSON.stringify({ submitted: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
