import { hmacHex } from "./crypto.js";
import { timingSafeEqualHex } from "./encoding.js";
import { HttpError } from "./http.js";

const DEFAULT_PUBLIC_URL = "https://ews.kylemcdonald.net/";

export function getPublicBaseUrl(env) {
  return String(env.APP_BASE_URL || env.EWS_PUBLIC_URL || DEFAULT_PUBLIC_URL)
    .trim()
    .replace(/\/+$/, "");
}

export function getSubscriberStripeCustomerId(subscriber) {
  return subscriber?.stripe_customer_id || subscriber?.stripeCustomerId || null;
}

function requirePortalSecret(env) {
  const secret = String(env.NOTIFICATION_HASH_SECRET || "").trim();
  if (!secret) {
    throw new HttpError(500, "Missing required secret: NOTIFICATION_HASH_SECRET.");
  }

  return secret;
}

async function createCustomerPortalToken(env, subscriber) {
  const customerId = getSubscriberStripeCustomerId(subscriber);
  if (!subscriber?.id || !customerId) {
    throw new HttpError(500, "Subscriber is missing Stripe customer portal fields.");
  }

  return hmacHex(requirePortalSecret(env), `customer_portal:${subscriber.id}:${customerId}`);
}

export async function createCustomerPortalLink(env, subscriber) {
  const token = await createCustomerPortalToken(env, subscriber);
  const url = new URL("/api/stripe/customer-portal", getPublicBaseUrl(env));
  url.searchParams.set("subscriber", subscriber.id);
  url.searchParams.set("token", token);

  return url.toString();
}

export async function verifyCustomerPortalToken(env, subscriber, token) {
  const expectedToken = await createCustomerPortalToken(env, subscriber);
  return timingSafeEqualHex(token, expectedToken);
}
