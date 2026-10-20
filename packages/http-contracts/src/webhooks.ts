/**
 * Webhook contracts (webhook notifications design: "Management API" and
 * "Wire format"; milestone WH1).
 *
 *   POST   /api/v1/webhooks                     <- CreateWebhookParams
 *                                               -> CreateWebhookResponse
 *   GET    /api/v1/webhooks                     -> WebhookListResponse
 *   DELETE /api/v1/webhooks/:webhookId          -> 204
 *   GET    /api/v1/webhooks/:webhookId/deliveries
 *                                               -> WebhookDeliveriesResponse
 *
 * A subscription pushes the same feed-shaped event payload as
 * `GET /api/v1/events`; its `cursor` is the zero-padded 16-digit rowid at the
 * next event boundary. The signing secret is returned only by the creation
 * response and is deliberately absent from every subscription shape.
 */

import {
  arrayOf,
  canonicalTimestamp,
  counterField,
  field,
  identifierField,
  integerField,
  MAX_TEXT_LENGTH,
  nullableField,
  object,
  oneOf,
  optional,
  text,
  type Decoder,
} from "./decode.js";

/** Longest accepted webhook URL, matching the design's storage constraint. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

/** Most audit actions one subscription filter may carry. */
export const MAX_WEBHOOK_ACTION_FILTER_ENTRIES = 32;

/** Longest accepted audit action in a subscription filter or delivery row. */
export const MAX_WEBHOOK_ACTION_LENGTH = 64;

/**
 * Hard ceiling for one decoded subscriptions/deliveries array, bounded at 4096
 * like the existing detail responses; the routes return at most 50 deliveries.
 */
export const MAX_WEBHOOK_RESPONSE_ITEMS = 4096;

/** Delivery lifecycle vocabulary; the closed status union on the ops view. */
export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "exhausted"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const webhookDeliveryStatusDecoder: Decoder<WebhookDeliveryStatus> = oneOf(
  WEBHOOK_DELIVERY_STATUSES,
  "status",
);

/** Zero-padded 16-digit decimal audit rowid (the feed's cursor format). */
const WEBHOOK_CURSOR_PATTERN = /^[0-9]{16}$/;

function webhookCursorField(label: string): Decoder<string> {
  return text({ max: 16, label, pattern: WEBHOOK_CURSOR_PATTERN });
}

/** URL text as accepted by the contract; scheme/userinfo checks are the boundary's job. */
const decodeWebhookUrl: Decoder<string> = text({
  max: MAX_WEBHOOK_URL_LENGTH,
  label: "url",
  pattern: /^\S+$/,
});

/** Audit action filter entries mirror the feed filter's count and length bounds. */
const decodeWebhookActions: Decoder<readonly string[]> = arrayOf(
  text({ max: MAX_WEBHOOK_ACTION_LENGTH, label: "actions entry", pattern: /^\S+$/ }),
  { label: "actions", maxLength: MAX_WEBHOOK_ACTION_FILTER_ENTRIES },
);

/** `POST /api/v1/webhooks` body; absent filters mean "all actions/cases". */
export interface CreateWebhookParams {
  readonly url: string;
  readonly actions?: readonly string[];
  readonly caseId?: string;
}

export const decodeCreateWebhookParams: Decoder<CreateWebhookParams> = (value, path) => {
  const decoded = object(
    {
      url: field(decodeWebhookUrl),
      actions: optional(decodeWebhookActions),
      caseId: optional(identifierField("caseId")),
    },
    "create webhook request",
  )(value, path);
  return {
    url: decoded.url,
    ...(decoded.actions === undefined ? {} : { actions: decoded.actions }),
    ...(decoded.caseId === undefined ? {} : { caseId: decoded.caseId }),
  };
};

export function encodeCreateWebhookParams(params: CreateWebhookParams): Record<string, unknown> {
  return {
    url: params.url,
    ...(params.actions === undefined ? {} : { actions: params.actions }),
    ...(params.caseId === undefined ? {} : { caseId: params.caseId }),
  };
}

/** Operator-visible subscription row; never carries the signing secret. */
export interface WebhookSubscription {
  readonly id: string;
  readonly url: string;
  readonly actions: readonly string[] | null;
  readonly caseId: string | null;
  /** Next audit rowid, zero-padded to 16 decimal digits. */
  readonly cursor: string;
  readonly createdAt: string;
}

const webhookSubscriptionShape = {
  id: field(identifierField("id")),
  url: field(decodeWebhookUrl),
  actions: field(nullableField(decodeWebhookActions)),
  caseId: field(nullableField(identifierField("caseId"))),
  cursor: field(webhookCursorField("cursor")),
  createdAt: field(canonicalTimestamp("createdAt")),
} as const;

export const decodeWebhookSubscription: Decoder<WebhookSubscription> = (value, path) => {
  const decoded = object(webhookSubscriptionShape, "webhook subscription")(value, path);
  return {
    id: decoded.id,
    url: decoded.url,
    actions: decoded.actions,
    caseId: decoded.caseId,
    cursor: decoded.cursor,
    createdAt: decoded.createdAt,
  };
};

export function encodeWebhookSubscription(subscription: WebhookSubscription): Record<string, unknown> {
  return {
    id: subscription.id,
    url: subscription.url,
    actions: subscription.actions,
    caseId: subscription.caseId,
    cursor: subscription.cursor,
    createdAt: subscription.createdAt,
  };
}

/** `POST /api/v1/webhooks` success; `secret` appears only in this response. */
export interface CreateWebhookResponse {
  readonly subscription: WebhookSubscription;
  readonly secret: string;
}

export const decodeCreateWebhookResponse: Decoder<CreateWebhookResponse> = (value, path) => {
  const decoded = object(
    {
      subscription: field(decodeWebhookSubscription),
      secret: field(identifierField("secret")),
    },
    "create webhook response",
  )(value, path);
  return { subscription: decoded.subscription, secret: decoded.secret };
};

export function encodeCreateWebhookResponse(response: CreateWebhookResponse): Record<string, unknown> {
  return {
    subscription: encodeWebhookSubscription(response.subscription),
    secret: response.secret,
  };
}

/** `GET /api/v1/webhooks` body. */
export interface WebhookListResponse {
  readonly subscriptions: readonly WebhookSubscription[];
}

export const decodeWebhookListResponse: Decoder<WebhookListResponse> = (value, path) => {
  const decoded = object(
    {
      subscriptions: field(
        arrayOf(decodeWebhookSubscription, {
          label: "subscriptions",
          maxLength: MAX_WEBHOOK_RESPONSE_ITEMS,
        }),
      ),
    },
    "webhook list response",
  )(value, path);
  return { subscriptions: decoded.subscriptions };
};

export function encodeWebhookListResponse(response: WebhookListResponse): Record<string, unknown> {
  return { subscriptions: response.subscriptions.map(encodeWebhookSubscription) };
}

/** One delivery attempt history row on the operator ops view. */
export interface WebhookDelivery {
  readonly id: string;
  readonly subscriptionId: string;
  /** Audit rowid of the delivered event, zero-padded to 16 decimal digits. */
  readonly eventCursor: string;
  readonly action: string;
  readonly dumpId: string | null;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
}

const webhookDeliveryShape = {
  id: field(identifierField("id")),
  subscriptionId: field(identifierField("subscriptionId")),
  eventCursor: field(webhookCursorField("eventCursor")),
  action: field(text({ max: MAX_WEBHOOK_ACTION_LENGTH, label: "action" })),
  dumpId: field(nullableField(identifierField("dumpId"))),
  status: field(webhookDeliveryStatusDecoder),
  attempts: field(counterField("attempts")),
  lastStatusCode: field(
    nullableField(integerField({ min: 100, max: 599, label: "lastStatusCode" })),
  ),
  lastError: field(nullableField(text({ max: MAX_TEXT_LENGTH, label: "lastError" }))),
  nextAttemptAt: field(nullableField(canonicalTimestamp("nextAttemptAt"))),
  deliveredAt: field(nullableField(canonicalTimestamp("deliveredAt"))),
  createdAt: field(canonicalTimestamp("createdAt")),
} as const;

export const decodeWebhookDelivery: Decoder<WebhookDelivery> = (value, path) => {
  const decoded = object(webhookDeliveryShape, "webhook delivery")(value, path);
  return {
    id: decoded.id,
    subscriptionId: decoded.subscriptionId,
    eventCursor: decoded.eventCursor,
    action: decoded.action,
    dumpId: decoded.dumpId,
    status: decoded.status,
    attempts: decoded.attempts,
    lastStatusCode: decoded.lastStatusCode,
    lastError: decoded.lastError,
    nextAttemptAt: decoded.nextAttemptAt,
    deliveredAt: decoded.deliveredAt,
    createdAt: decoded.createdAt,
  };
};

export function encodeWebhookDelivery(delivery: WebhookDelivery): Record<string, unknown> {
  return {
    id: delivery.id,
    subscriptionId: delivery.subscriptionId,
    eventCursor: delivery.eventCursor,
    action: delivery.action,
    dumpId: delivery.dumpId,
    status: delivery.status,
    attempts: delivery.attempts,
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    nextAttemptAt: delivery.nextAttemptAt,
    deliveredAt: delivery.deliveredAt,
    createdAt: delivery.createdAt,
  };
}

/** `GET /api/v1/webhooks/:webhookId/deliveries` body, most recent first. */
export interface WebhookDeliveriesResponse {
  readonly deliveries: readonly WebhookDelivery[];
}

export const decodeWebhookDeliveriesResponse: Decoder<WebhookDeliveriesResponse> = (value, path) => {
  const decoded = object(
    {
      deliveries: field(
        arrayOf(decodeWebhookDelivery, {
          label: "deliveries",
          maxLength: MAX_WEBHOOK_RESPONSE_ITEMS,
        }),
      ),
    },
    "webhook deliveries response",
  )(value, path);
  return { deliveries: decoded.deliveries };
};

export function encodeWebhookDeliveriesResponse(
  response: WebhookDeliveriesResponse,
): Record<string, unknown> {
  return { deliveries: response.deliveries.map(encodeWebhookDelivery) };
}
