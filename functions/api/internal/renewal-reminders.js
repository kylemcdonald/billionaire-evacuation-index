import { handleError, jsonResponse, readJsonRequest } from "../../_lib/http.js";
import { requireInternalAuth } from "../../_lib/internal-auth.js";
import { sendRenewalReminderBatch } from "../../_lib/notifications.js";

async function readOptionalJsonRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  return readJsonRequest(request);
}

export async function onRequestPost({ request, env }) {
  try {
    requireInternalAuth(request, env);
    const payload = await readOptionalJsonRequest(request);
    const result = await sendRenewalReminderBatch(env, {
      limit: payload.limit,
      concurrency: payload.concurrency,
      source: "github_actions_renewal_reminder",
    });
    return jsonResponse(result, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
