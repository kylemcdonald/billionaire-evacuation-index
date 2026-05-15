import {
  createManualSubscriber,
  getSignupConfirmationBatchCandidates,
  getSubscriberById,
  hydrateSubscriberContacts,
} from "../../_lib/db.js";
import { createAccountManagementLink } from "../../_lib/customer-portal.js";
import { handleError, HttpError, jsonResponse, getRequestIp, getRequestUserAgent, readJsonRequest } from "../../_lib/http.js";
import { sendSignupConfirmationToSubscriber } from "../../_lib/notifications.js";

function getNotificationBaseUrl(env) {
  return String(env.EWS_NOTIFICATION_URL || "https://aews.cc/")
    .trim()
    .replace(/\/+$/, "");
}

async function mapSubscriberResult(env, subscriber) {
  const hydrated = subscriber.email_cipher || subscriber.account_email_cipher ? await hydrateSubscriberContacts(env, subscriber) : subscriber;
  const managementUrl = await createAccountManagementLink(env, hydrated, { baseUrl: getNotificationBaseUrl(env) });
  return {
    id: hydrated.id,
    status: hydrated.status,
    source: hydrated.source,
    accountEmail: hydrated.accountEmail,
    email: hydrated.email,
    phone: hydrated.phone,
    wantsEmail: hydrated.wantsEmail,
    wantsSms: hydrated.wantsSms,
    managementUrl,
  };
}

export async function onRequestPost({ request, env }) {
  try {
    const payload = await readJsonRequest(request);
    const action = String(payload.action || "").trim();

    if (action === "create_manual") {
      const subscriber = await createManualSubscriber(env, payload, {
        ip: getRequestIp(request),
        userAgent: getRequestUserAgent(request),
      });
      return jsonResponse({
        ok: true,
        subscriber: await mapSubscriberResult(env, subscriber),
      });
    }

    if (action === "send_signup_confirmation") {
      const subscriberId = String(payload.subscriberId || "").trim();
      if (!subscriberId) {
        throw new HttpError(400, "Enter a subscriber ID.");
      }
      const subscriber = await getSubscriberById(env, subscriberId);
      if (!subscriber) {
        throw new HttpError(404, "Subscriber not found.");
      }
      const result = await sendSignupConfirmationToSubscriber(env, subscriberId, {
        channels: {
          email: payload.email !== false,
          sms: payload.sms !== false,
        },
        skipAlreadySent: payload.skipAlreadySent === true,
      });
      return jsonResponse({
        ok: result.ok,
        result,
        subscriber: await mapSubscriberResult(env, subscriber),
      });
    }

    if (action === "send_signup_confirmation_batch") {
      const candidates = await getSignupConfirmationBatchCandidates(env, {
        cursor: payload.cursor,
        limit: payload.limit,
      });
      const summary = {
        ok: true,
        scannedCount: candidates.length,
        sentSubscriberCount: 0,
        skippedSubscriberCount: 0,
        emailSentCount: 0,
        smsSentCount: 0,
        errorCount: 0,
        errors: [],
        nextCursor: candidates.at(-1)?.id || String(payload.cursor || "").trim(),
        done: candidates.length === 0,
      };

      for (const candidate of candidates) {
        try {
          const result = await sendSignupConfirmationToSubscriber(env, candidate.id, {
            source: "admin_batch",
            skipAlreadySent: true,
          });
          if (result.sent) {
            summary.sentSubscriberCount += 1;
          }
          if (result.skipped) {
            summary.skippedSubscriberCount += 1;
          }
          summary.emailSentCount += Number(result.emailSentCount || 0);
          summary.smsSentCount += Number(result.smsSentCount || 0);
          summary.errorCount += Number(result.errorCount || 0);
          if (!result.ok) {
            summary.ok = false;
          }
        } catch (error) {
          summary.ok = false;
          summary.errorCount += 1;
          if (summary.errors.length < 5) {
            summary.errors.push({
              subscriberId: candidate.id,
              error: error.message,
            });
          }
        }
      }

      return jsonResponse(summary);
    }

    throw new HttpError(400, "Unknown subscriber admin action.");
  } catch (error) {
    return handleError(error);
  }
}
