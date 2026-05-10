import { createBillingPortalSession } from "../../_lib/stripe.js";
import { getSubscriberForCustomerPortal } from "../../_lib/db.js";
import {
  getPublicBaseUrl,
  getSubscriberStripeCustomerId,
  verifyCustomerPortalToken,
} from "../../_lib/customer-portal.js";
import { handleError, HttpError } from "../../_lib/http.js";

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const subscriberId = url.searchParams.get("subscriber") || "";
    const token = url.searchParams.get("token") || "";
    if (!subscriberId || !token) {
      throw new HttpError(400, "Missing customer portal link token.");
    }

    const subscriber = await getSubscriberForCustomerPortal(env, subscriberId);
    if (!subscriber) {
      throw new HttpError(404, "Subscriber not found.");
    }

    const tokenMatches = await verifyCustomerPortalToken(env, subscriber, token);
    if (!tokenMatches) {
      throw new HttpError(403, "Invalid customer portal link token.");
    }

    const customerId = getSubscriberStripeCustomerId(subscriber);
    if (!customerId) {
      throw new HttpError(404, "Subscriber does not have a Stripe customer record.");
    }

    const session = await createBillingPortalSession(env, {
      customerId,
      returnUrl: getPublicBaseUrl(env),
    });
    if (!session?.url) {
      throw new HttpError(502, "Stripe did not return a billing portal URL.");
    }

    return Response.redirect(session.url, 303);
  } catch (error) {
    return handleError(error);
  }
}
