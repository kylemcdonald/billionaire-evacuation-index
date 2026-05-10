import { basicAuth, timingSafeEqualHex } from "./encoding.js";
import { hmacHex } from "./crypto.js";
import { HttpError } from "./http.js";

const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
const DEFAULT_STRIPE_PRODUCT_ID = "prod_USlMnoY4GL7OAn";
const WEBHOOK_TOLERANCE_SECONDS = 300;

function requireEnv(env, key) {
  const value = String(env[key] || "").trim();
  if (!value) {
    throw new HttpError(500, `Missing required Stripe setting: ${key}.`);
  }

  return value;
}

function encodeStripeForm(pairs) {
  const params = new URLSearchParams();
  for (const [key, value] of pairs) {
    if (value !== undefined && value !== null && value !== "") {
      params.append(key, String(value));
    }
  }

  return params;
}

async function stripeRequest(env, method, path, pairs = []) {
  const secretKey = requireEnv(env, "STRIPE_SECRET_KEY");
  const init = {
    method,
    headers: {
      authorization: basicAuth(secretKey, ""),
    },
  };

  let url = `${STRIPE_API_BASE_URL}${path}`;
  if (method === "GET") {
    const query = encodeStripeForm(pairs).toString();
    if (query) {
      url += `?${query}`;
    }
  } else {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = encodeStripeForm(pairs);
  }

  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(
      response.status >= 500 ? 502 : response.status,
      payload.error?.message || `Stripe API request failed with ${response.status}.`,
    );
  }

  return payload;
}

export function getStripeProductId(env) {
  return String(env.STRIPE_PRODUCT_ID || DEFAULT_STRIPE_PRODUCT_ID).trim();
}

export async function resolveStripePriceId(env) {
  const configuredPriceId = String(env.STRIPE_PRICE_ID || "").trim();
  if (configuredPriceId) {
    return configuredPriceId;
  }

  const productId = getStripeProductId(env);
  const prices = await stripeRequest(env, "GET", "/prices", [
    ["product", productId],
    ["active", "true"],
    ["limit", "100"],
  ]);

  const price =
    prices.data?.find(
      (candidate) =>
        candidate.active &&
        candidate.recurring?.interval === "year" &&
        Number(candidate.unit_amount || 0) === 500 &&
        String(candidate.currency || "").toLowerCase() === "usd",
    ) ||
    prices.data?.find((candidate) => candidate.active && candidate.recurring?.interval === "year") ||
    prices.data?.find((candidate) => candidate.active);

  if (!price?.id) {
    throw new HttpError(500, `No active Stripe price found for product ${productId}.`);
  }

  return price.id;
}

export async function createCheckoutSession(env, { signupId, email, priceId, baseUrl }) {
  return stripeRequest(env, "POST", "/checkout/sessions", [
    ["mode", "subscription"],
    ["client_reference_id", signupId],
    ["customer_email", email],
    ["line_items[0][price]", priceId],
    ["line_items[0][quantity]", "1"],
    ["success_url", `${baseUrl}/signup?success=1&session_id={CHECKOUT_SESSION_ID}`],
    ["cancel_url", `${baseUrl}/signup?canceled=1`],
    ["metadata[signup_id]", signupId],
    ["subscription_data[metadata][signup_id]", signupId],
  ]);
}

export async function createBillingPortalSession(env, { customerId, returnUrl }) {
  if (!customerId) {
    throw new HttpError(400, "Missing Stripe customer ID for billing portal session.");
  }

  return stripeRequest(env, "POST", "/billing_portal/sessions", [
    ["customer", customerId],
    ["return_url", returnUrl],
  ]);
}

function parseStripeSignature(signatureHeader) {
  const parts = String(signatureHeader || "").split(",");
  const parsed = {
    timestamp: null,
    signatures: [],
  };

  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t") {
      parsed.timestamp = Number(value);
    }
    if (key === "v1" && value) {
      parsed.signatures.push(value);
    }
  }

  return parsed;
}

export async function verifyStripeWebhook(request, env) {
  const webhookSecret = requireEnv(env, "STRIPE_WEBHOOK_SECRET");
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature") || "";
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);

  if (!timestamp || !signatures.length) {
    throw new HttpError(400, "Missing Stripe webhook signature.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new HttpError(400, "Stripe webhook signature timestamp is outside the allowed tolerance.");
  }

  const expectedSignature = await hmacHex(webhookSecret, `${timestamp}.${rawBody}`);
  const signatureMatches = signatures.some((signature) => timingSafeEqualHex(signature, expectedSignature));
  if (!signatureMatches) {
    throw new HttpError(400, "Stripe webhook signature verification failed.");
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, "Stripe webhook payload is not valid JSON.");
  }
}
