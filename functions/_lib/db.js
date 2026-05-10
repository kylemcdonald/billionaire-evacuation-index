import { contactHash, decryptString, encryptString, metadataHash } from "./crypto.js";
import { HttpError } from "./http.js";

export const SUBSCRIBER_STATUS = {
  PENDING: "pending_checkout",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
};

const DEFAULT_PENDING_SIGNUP_CONTACT_RETENTION_HOURS = 24;

function getDb(env) {
  if (!env.EWS_NOTIFY_DB) {
    throw new HttpError(500, "Missing D1 binding: EWS_NOTIFY_DB.");
  }

  return env.EWS_NOTIFY_DB;
}

function shouldUseRemoteSubscriberReads(env) {
  return String(env.ADMIN_SUBSCRIBERS_REMOTE_D1 || "").trim() === "1";
}

async function remoteD1Query(env, sql, params = []) {
  const apiToken = String(env.CLOUDFLARE_API_TOKEN || "").trim();
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const databaseId = String(env.CLOUDFLARE_D1_DATABASE_ID || "").trim();
  if (!apiToken || !accountId || !databaseId) {
    throw new HttpError(500, "Missing Cloudflare API settings for remote D1 subscriber reads.");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sql,
        params,
      }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    throw new HttpError(
      response.status >= 500 ? 502 : response.status,
      payload.errors?.[0]?.message || `Cloudflare D1 query failed with ${response.status}.`,
    );
  }

  const result = payload.result?.[0];
  if (!result?.success) {
    throw new HttpError(502, result?.error || "Cloudflare D1 query failed.");
  }

  return result.results || [];
}

function nowIso() {
  return new Date().toISOString();
}

function unixSecondsToIso(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return new Date(numericValue * 1000).toISOString();
}

function getPendingSignupContactRetentionHours(env) {
  const configuredHours = Number(env.PENDING_SIGNUP_CONTACT_RETENTION_HOURS || 0);
  if (Number.isFinite(configuredHours) && configuredHours > 0) {
    return configuredHours;
  }

  return DEFAULT_PENDING_SIGNUP_CONTACT_RETENTION_HOURS;
}

function getSubscriptionCurrentPeriodEnd(subscription) {
  return (
    subscription.current_period_end ||
    subscription.items?.data?.find((item) => item?.current_period_end)?.current_period_end ||
    null
  );
}

async function firstByContactHashes(env, emailHash, phoneHash) {
  if (!emailHash && !phoneHash) {
    return null;
  }

  const db = getDb(env);
  if (emailHash && phoneHash) {
    return db
      .prepare(
        `
          SELECT *
          FROM notification_signups
          WHERE email_hash = ? OR phone_hash = ?
          ORDER BY
            CASE status WHEN 'active' THEN 0 WHEN 'pending_checkout' THEN 1 ELSE 2 END,
            updated_at DESC
          LIMIT 1
        `,
      )
      .bind(emailHash, phoneHash)
      .first();
  }

  const column = emailHash ? "email_hash" : "phone_hash";
  return db
    .prepare(
      `
        SELECT *
        FROM notification_signups
        WHERE ${column} = ?
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'pending_checkout' THEN 1 ELSE 2 END,
          updated_at DESC
        LIMIT 1
      `,
    )
    .bind(emailHash || phoneHash)
    .first();
}

export async function createPendingSignup(env, contacts, requestContext = {}) {
  const [emailHash, phoneHash, emailCipher, phoneCipher, consentIpHash, consentUserAgentHash] = await Promise.all([
    contactHash(env, "email", contacts.email),
    contactHash(env, "phone", contacts.phone),
    encryptString(env, contacts.email),
    encryptString(env, contacts.phone),
    metadataHash(env, "sms_consent_ip", requestContext.ip),
    metadataHash(env, "sms_consent_user_agent", requestContext.userAgent),
  ]);

  const existing = await firstByContactHashes(env, emailHash, phoneHash);
  if (existing?.status === SUBSCRIBER_STATUS.ACTIVE) {
    throw new HttpError(409, "That email address or phone number is already subscribed.");
  }

  const db = getDb(env);
  const id = existing?.id || crypto.randomUUID();
  const createdAt = existing?.created_at || nowIso();
  const timestamp = nowIso();
  const smsConsentAt = contacts.phone && contacts.smsConsent ? timestamp : null;

  if (existing) {
    await db
      .prepare(
        `
          UPDATE notification_signups
          SET
            status = ?,
            email_cipher = ?,
            email_hash = ?,
            phone_cipher = ?,
            phone_hash = ?,
            wants_email = ?,
            wants_sms = ?,
            sms_consent_at = ?,
            sms_consent_ip_hash = ?,
            sms_consent_user_agent_hash = ?,
            stripe_checkout_session_id = NULL,
            checkout_url = NULL,
            checkout_created_at = NULL,
            checkout_completed_at = NULL,
            canceled_at = NULL,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(
        SUBSCRIBER_STATUS.PENDING,
        emailCipher,
        emailHash,
        phoneCipher,
        phoneHash,
        contacts.wantsEmail ? 1 : 0,
        contacts.wantsSms ? 1 : 0,
        smsConsentAt,
        consentIpHash,
        consentUserAgentHash,
        timestamp,
        id,
      )
      .run();
  } else {
    await db
      .prepare(
        `
          INSERT INTO notification_signups (
            id,
            status,
            email_cipher,
            email_hash,
            phone_cipher,
            phone_hash,
            wants_email,
            wants_sms,
            sms_consent_at,
            sms_consent_ip_hash,
            sms_consent_user_agent_hash,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(
        id,
        SUBSCRIBER_STATUS.PENDING,
        emailCipher,
        emailHash,
        phoneCipher,
        phoneHash,
        contacts.wantsEmail ? 1 : 0,
        contacts.wantsSms ? 1 : 0,
        smsConsentAt,
        consentIpHash,
        consentUserAgentHash,
        createdAt,
        timestamp,
      )
      .run();
  }

  return {
    id,
    email: contacts.email,
    phone: contacts.phone,
  };
}

export async function recordCheckoutSession(env, signupId, checkoutSession, priceId, productId) {
  const db = getDb(env);
  await db
    .prepare(
      `
        UPDATE notification_signups
        SET
          stripe_checkout_session_id = ?,
          stripe_product_id = ?,
          stripe_price_id = ?,
          checkout_url = ?,
          checkout_created_at = ?,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      checkoutSession.id || null,
      productId || null,
      priceId || null,
      checkoutSession.url || null,
      unixSecondsToIso(checkoutSession.created) || nowIso(),
      nowIso(),
      signupId,
    )
    .run();
}

export async function anonymizeExpiredPendingSignups(env, options = {}) {
  const retentionHours =
    Number.isFinite(Number(options.retentionHours)) && Number(options.retentionHours) > 0
      ? Number(options.retentionHours)
      : getPendingSignupContactRetentionHours(env);
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
  const cutoffEpochSeconds = Math.floor(cutoff.getTime() / 1000);
  const timestamp = nowIso();

  const result = await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          email_cipher = NULL,
          email_hash = NULL,
          phone_cipher = NULL,
          phone_hash = NULL,
          sms_consent_ip_hash = NULL,
          sms_consent_user_agent_hash = NULL,
          checkout_url = NULL,
          contact_redacted_at = ?,
          updated_at = ?
        WHERE status = ?
          AND contact_redacted_at IS NULL
          AND CAST(COALESCE(strftime('%s', checkout_created_at), strftime('%s', created_at), '0') AS INTEGER) <= ?
          AND (
            email_cipher IS NOT NULL
            OR email_hash IS NOT NULL
            OR phone_cipher IS NOT NULL
            OR phone_hash IS NOT NULL
            OR sms_consent_ip_hash IS NOT NULL
            OR sms_consent_user_agent_hash IS NOT NULL
            OR checkout_url IS NOT NULL
          )
      `,
    )
    .bind(timestamp, timestamp, SUBSCRIBER_STATUS.PENDING, cutoffEpochSeconds)
    .run();

  return {
    ok: true,
    retentionHours,
    cutoff: cutoff.toISOString(),
    redactedCount: result.meta?.changes || 0,
  };
}

export async function activateSubscriberFromCheckout(env, checkoutSession) {
  const signupId = checkoutSession.metadata?.signup_id || checkoutSession.client_reference_id || null;
  const sessionId = checkoutSession.id || null;
  if (!signupId && !sessionId) {
    return null;
  }

  const db = getDb(env);
  const subscriber = signupId
    ? await db.prepare("SELECT * FROM notification_signups WHERE id = ?").bind(signupId).first()
    : await db
        .prepare("SELECT * FROM notification_signups WHERE stripe_checkout_session_id = ?")
        .bind(sessionId)
        .first();

  if (!subscriber) {
    return null;
  }

  const stripeEmail = checkoutSession.customer_details?.email || checkoutSession.customer_email || null;
  let emailCipher = subscriber.email_cipher;
  let emailHash = subscriber.email_hash;
  let wantsEmail = Number(subscriber.wants_email || 0);
  if (!emailCipher && stripeEmail) {
    const normalizedEmail = String(stripeEmail).trim().toLowerCase();
    emailCipher = await encryptString(env, normalizedEmail);
    emailHash = await contactHash(env, "email", normalizedEmail);
  }

  await db
    .prepare(
      `
        UPDATE notification_signups
        SET
          status = ?,
          email_cipher = ?,
          email_hash = ?,
          wants_email = ?,
          stripe_customer_id = ?,
          stripe_subscription_id = ?,
          stripe_checkout_session_id = ?,
          checkout_completed_at = ?,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      SUBSCRIBER_STATUS.ACTIVE,
      emailCipher,
      emailHash,
      wantsEmail,
      checkoutSession.customer || null,
      checkoutSession.subscription || null,
      sessionId,
      nowIso(),
      nowIso(),
      subscriber.id,
    )
    .run();

  return subscriber.id;
}

export async function cancelPendingSubscriberByCheckout(env, checkoutSession) {
  const sessionId = checkoutSession.id || null;
  if (!sessionId) {
    return 0;
  }

  const timestamp = nowIso();
  const result = await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          status = ?,
          email_cipher = NULL,
          email_hash = NULL,
          phone_cipher = NULL,
          phone_hash = NULL,
          sms_consent_ip_hash = NULL,
          sms_consent_user_agent_hash = NULL,
          checkout_url = NULL,
          canceled_at = ?,
          contact_redacted_at = COALESCE(contact_redacted_at, ?),
          updated_at = ?
        WHERE stripe_checkout_session_id = ?
          AND status = ?
      `,
    )
    .bind(SUBSCRIBER_STATUS.CANCELED, timestamp, timestamp, timestamp, sessionId, SUBSCRIBER_STATUS.PENDING)
    .run();

  return result.meta?.changes || 0;
}

export async function updateSubscriberFromSubscription(env, subscription) {
  const subscriptionId = subscription.id || null;
  if (!subscriptionId) {
    return null;
  }

  const db = getDb(env);
  const signupId = subscription.metadata?.signup_id || null;
  const subscriber = signupId
    ? await db.prepare("SELECT * FROM notification_signups WHERE id = ?").bind(signupId).first()
    : await db
        .prepare("SELECT * FROM notification_signups WHERE stripe_subscription_id = ?")
        .bind(subscriptionId)
        .first();

  if (!subscriber) {
    return null;
  }

  const stripeStatus = String(subscription.status || "");
  const nextStatus =
    stripeStatus === "active" || stripeStatus === "trialing"
      ? SUBSCRIBER_STATUS.ACTIVE
      : stripeStatus === "canceled" || stripeStatus === "incomplete_expired"
        ? SUBSCRIBER_STATUS.CANCELED
        : SUBSCRIBER_STATUS.PAST_DUE;

  await db
    .prepare(
      `
        UPDATE notification_signups
        SET
          status = ?,
          stripe_customer_id = COALESCE(?, stripe_customer_id),
          stripe_subscription_id = ?,
          current_period_end = ?,
          canceled_at = ?,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      nextStatus,
      subscription.customer || null,
      subscriptionId,
      unixSecondsToIso(getSubscriptionCurrentPeriodEnd(subscription)),
      nextStatus === SUBSCRIBER_STATUS.CANCELED ? nowIso() : null,
      nowIso(),
      subscriber.id,
    )
    .run();

  return subscriber.id;
}

export async function cancelSubscriberBySubscription(env, subscription) {
  const subscriptionId = subscription.id || null;
  if (!subscriptionId) {
    return null;
  }

  const db = getDb(env);
  const result = await db
    .prepare(
      `
        UPDATE notification_signups
        SET
          status = ?,
          canceled_at = ?,
          updated_at = ?
        WHERE stripe_subscription_id = ?
      `,
    )
    .bind(SUBSCRIBER_STATUS.CANCELED, nowIso(), nowIso(), subscriptionId)
    .run();

  return result.meta?.changes || 0;
}

export async function getActiveSubscribers(env) {
  const db = getDb(env);
  const { results } = await db
    .prepare(
      `
        SELECT *
        FROM notification_signups
        WHERE status = ?
          AND (wants_email = 1 OR wants_sms = 1)
        ORDER BY created_at ASC
      `,
    )
    .bind(SUBSCRIBER_STATUS.ACTIVE)
    .all();

  return results || [];
}

export async function hydrateSubscriberContacts(env, subscriber) {
  const [email, phone] = await Promise.all([
    decryptString(env, subscriber.email_cipher),
    decryptString(env, subscriber.phone_cipher),
  ]);

  return {
    ...subscriber,
    email,
    phone,
    wantsEmail: Number(subscriber.wants_email || 0) === 1,
    wantsSms: Number(subscriber.wants_sms || 0) === 1,
  };
}

export async function getMetaValue(env, key) {
  const row = await getDb(env).prepare("SELECT value FROM notification_meta WHERE key = ?").bind(key).first();
  return row?.value || null;
}

export async function setMetaValue(env, key, value) {
  await getDb(env)
    .prepare(
      `
        INSERT INTO notification_meta (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
    )
    .bind(key, String(value), nowIso())
    .run();
}

async function recalculateAlertDeliveryCounts(env, alertId) {
  const row = await getDb(env)
    .prepare(
      `
        SELECT
          SUM(CASE WHEN channel = 'email' AND status IN ('sent', 'delivered') THEN 1 ELSE 0 END) AS email_sent_count,
          SUM(CASE WHEN channel = 'sms' AND status IN ('sent', 'delivered') THEN 1 ELSE 0 END) AS sms_sent_count,
          SUM(CASE WHEN status IN ('failed', 'undelivered') THEN 1 ELSE 0 END) AS error_count
        FROM notification_deliveries
        WHERE alert_id = ?
      `,
    )
    .bind(alertId)
    .first();

  const errorCount = Number(row?.error_count || 0);
  await getDb(env)
    .prepare(
      `
        UPDATE notification_alerts
        SET
          email_sent_count = ?,
          sms_sent_count = ?,
          error_count = ?,
          status = CASE
            WHEN ? > 0 THEN 'completed_with_errors'
            WHEN status = 'created' THEN 'sent'
            ELSE status
          END,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      Number(row?.email_sent_count || 0),
      Number(row?.sms_sent_count || 0),
      errorCount,
      errorCount,
      nowIso(),
      alertId,
    )
    .run();
}

export async function createAlertRecord(env, { kind, source, level, slotKey, messageText, status = "created" }) {
  const id = crypto.randomUUID();
  await getDb(env)
    .prepare(
      `
        INSERT INTO notification_alerts (
          id,
          kind,
          source,
          level,
          slot_key,
          message_text,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(id, kind, source, level ?? null, slotKey || null, messageText, status, nowIso())
    .run();

  return id;
}

export async function updateAlertRecord(env, alertId, summary) {
  await getDb(env)
    .prepare(
      `
        UPDATE notification_alerts
        SET
          status = ?,
          subscriber_count = ?,
          email_sent_count = ?,
          sms_sent_count = ?,
          error_count = ?,
          sent_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    )
    .bind(
      summary.status,
      summary.subscriberCount || 0,
      summary.emailSentCount || 0,
      summary.smsSentCount || 0,
      summary.errorCount || 0,
      nowIso(),
      alertId,
    )
    .run();
}

export async function recordDelivery(env, delivery) {
  await getDb(env)
    .prepare(
      `
        INSERT INTO notification_deliveries (
          id,
          alert_id,
          subscriber_id,
          channel,
          destination_hash,
          status,
          provider_message_id,
          error,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(
      crypto.randomUUID(),
      delivery.alertId,
      delivery.subscriberId || null,
      delivery.channel,
      delivery.destinationHash || null,
      delivery.status,
      delivery.providerMessageId || null,
      delivery.error ? String(delivery.error).slice(0, 1000) : null,
      nowIso(),
      nowIso(),
    )
    .run();
}

export async function getRecentAlertDeliveries(env, limit = 25) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const { results } = await getDb(env)
    .prepare(
      `
        SELECT
          a.id AS alert_id,
          a.kind,
          a.status AS alert_status,
          a.subscriber_count,
          a.email_sent_count,
          a.sms_sent_count,
          a.error_count,
          a.created_at AS alert_created_at,
          a.sent_at,
          d.channel,
          d.status AS delivery_status,
          d.provider_message_id,
          d.error,
          d.created_at AS delivery_created_at,
          d.updated_at AS delivery_updated_at
        FROM notification_alerts a
        LEFT JOIN notification_deliveries d ON d.alert_id = a.id
        ORDER BY a.created_at DESC, d.created_at DESC
        LIMIT ?
      `,
    )
    .bind(safeLimit)
    .all();

  return results || [];
}

export async function getAdminSubscriberRecords(env) {
  const query = `
        SELECT
          s.*,
          COUNT(d.id) AS delivery_count,
          SUM(CASE WHEN d.channel = 'email' THEN 1 ELSE 0 END) AS email_delivery_count,
          SUM(CASE WHEN d.channel = 'sms' THEN 1 ELSE 0 END) AS sms_delivery_count,
          SUM(CASE WHEN d.status IN ('failed', 'undelivered') THEN 1 ELSE 0 END) AS delivery_error_count,
          MAX(COALESCE(d.updated_at, d.created_at)) AS last_delivery_at
        FROM notification_signups s
        LEFT JOIN notification_deliveries d ON d.subscriber_id = s.id
        GROUP BY s.id
        ORDER BY
          CASE s.status
            WHEN 'active' THEN 0
            WHEN 'pending_checkout' THEN 1
            WHEN 'past_due' THEN 2
            ELSE 3
          END,
          s.updated_at DESC
      `;
  const results = shouldUseRemoteSubscriberReads(env)
    ? await remoteD1Query(env, query)
    : (await getDb(env).prepare(query).all()).results;

  return Promise.all(
    (results || []).map(async (row) => {
      const [email, phone] = await Promise.all([
        decryptString(env, row.email_cipher),
        decryptString(env, row.phone_cipher),
      ]);

      return {
        id: row.id,
        status: row.status,
        email,
        emailHash: row.email_hash,
        phone,
        phoneHash: row.phone_hash,
        wantsEmail: Number(row.wants_email || 0) === 1,
        wantsSms: Number(row.wants_sms || 0) === 1,
        smsConsentAt: row.sms_consent_at,
        smsConsentIpHash: row.sms_consent_ip_hash,
        smsConsentUserAgentHash: row.sms_consent_user_agent_hash,
        stripeCustomerId: row.stripe_customer_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        stripeCheckoutSessionId: row.stripe_checkout_session_id,
        stripeProductId: row.stripe_product_id,
        stripePriceId: row.stripe_price_id,
        checkoutUrl: row.checkout_url,
        checkoutCreatedAt: row.checkout_created_at,
        checkoutCompletedAt: row.checkout_completed_at,
        currentPeriodEnd: row.current_period_end,
        canceledAt: row.canceled_at,
        contactRedactedAt: row.contact_redacted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        hasEmailCipher: Boolean(row.email_cipher),
        hasPhoneCipher: Boolean(row.phone_cipher),
        deliveryCount: Number(row.delivery_count || 0),
        emailDeliveryCount: Number(row.email_delivery_count || 0),
        smsDeliveryCount: Number(row.sms_delivery_count || 0),
        deliveryErrorCount: Number(row.delivery_error_count || 0),
        lastDeliveryAt: row.last_delivery_at,
      };
    }),
  );
}

export async function getSubscriberForCustomerPortal(env, subscriberId) {
  if (!subscriberId) {
    return null;
  }

  return getDb(env)
    .prepare(
      `
        SELECT
          id,
          status,
          stripe_customer_id
        FROM notification_signups
        WHERE id = ?
      `,
    )
    .bind(subscriberId)
    .first();
}

export async function updateDeliveryByProviderMessageId(env, providerMessageId, { status, error = null }) {
  if (!providerMessageId) {
    return null;
  }

  const db = getDb(env);
  const existing = await db
    .prepare(
      `
        SELECT id, alert_id
        FROM notification_deliveries
        WHERE provider_message_id = ?
        LIMIT 1
      `,
    )
    .bind(providerMessageId)
    .first();
  if (!existing) {
    return null;
  }

  await db
    .prepare(
      `
        UPDATE notification_deliveries
        SET
          status = ?,
          error = ?,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(status, error ? String(error).slice(0, 1000) : null, nowIso(), existing.id)
    .run();

  await recalculateAlertDeliveryCounts(env, existing.alert_id);
  return existing.alert_id;
}

export async function updateSmsPreferenceByPhoneHash(env, phoneHash, wantsSms) {
  if (!phoneHash) {
    return 0;
  }

  const result = await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          wants_sms = ?,
          updated_at = ?
        WHERE phone_hash = ?
      `,
    )
    .bind(wantsSms ? 1 : 0, nowIso(), phoneHash)
    .run();

  return result.meta?.changes || 0;
}
