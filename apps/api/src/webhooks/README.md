# Customer message webhook

`POST /webhook` accepts the assessment's text-message event. Its local URL is `http://127.0.0.1:3001/webhook` by default.

## Authentication and validation

Send `Content-Type: application/json` and `X-Signature: sha256=<hex>`.
The signature is HMAC-SHA256 of the **exact UTF-8 request bytes**, using `WEBHOOK_SECRET` from the backend environment. The assessment's published test value is `verdant-demo-secret-2026`; it is a demo credential, not a private production secret. The browser will never need this secret.

The route's scoped parser preserves the bytes. A constant-time signature comparison runs before JSON decoding and schema validation. Reserializing JSON before checking the signature would be incorrect because whitespace, escaping, and property order can differ. Other routes retain their standard parsers.

```json
{
  "event_id": "evt_7f3a91c2",
  "type": "message.received",
  "brand_id": "verdant-co",
  "timestamp": "2026-11-03T10:15:22Z",
  "customer": {
    "id": "cust_1042",
    "name": "Aisha Khan",
    "phone": "+919800000001"
  },
  "message": {
    "id": "msg_88213",
    "type": "text",
    "text": "Hi, my order #4471 hasn't arrived yet. Can I change the delivery address?"
  }
}
```

Only `verdant-co`, `message.received`, and text messages are supported. Unknown fields and incorrectly typed values are rejected rather than silently changed. Bodies are limited to 64 KiB and message text to 10,000 characters. Empty/whitespace-only values, NUL bytes, and invalid timestamps are rejected. The assessment's timestamp can be in the future; no timestamp-age restriction is imposed.

## Storage and retries

`messages/receive.ts` is the shared saving-and-drafting flow that the future Customer view will also call after validation. Its storage service (`ingest.ts`) finds/creates the customer and conversation, saves the message and pending draft, and updates activity in one transaction. A storage failure rolls back those writes. After commit, it attempts Gemini generation outside the transaction. Receipt time determines activity; the supplied timestamp remains the message's sent time.

Customer-row locks serialize conversation updates, and unique database constraints protect against concurrent duplicate events. After a duplicate insert race, the losing transaction rolls back and reads the winning message.

An exact retry returns HTTP 200 with the original message and conversation IDs. It does not reset a ready/used/failed draft, update the customer, or advance activity. It may recover a pending draft with no active generation lease. A reused event/message ID with different IDs, customer identity, text, or sent time returns HTTP 409. This includes retrying a message ID with a new event ID: retain both IDs on retries. Customer names and phones may change on later messages, so they are not compared when detecting retries.

| Status | Meaning |
| --- | --- |
| 201 | New message committed; draft generation attempted |
| 200 | Matching message already handled |
| 400 | Invalid JSON or event payload |
| 401 | Missing or invalid signature |
| 409 | Reused identifier conflicts with existing message details |
| 413 | Request body too large |
| 415 | Unsupported content type |
| 500 | Storage/internal failure; sender can retry with the same IDs |

Success responses contain `status`, `messageId`, and `conversationId`. Errors contain a stable code, safe message, and request ID. Logs identify the request/event/message without logging customer text, SQL, passwords, or signatures.

The request awaits a bounded Gemini attempt (20-second provider timeout). Successful drafts become `ready`; provider failures become `failed` with a safe error code, while the saved message still receives 2xx. No reply is sent automatically and no draft text is returned by the webhook. Active concurrent attempts remain `pending`; abandoned generation can be reclaimed after 60 seconds. Explicit retries use authenticated `POST /agent/drafts/:id/retry` or the local `ai:retry` command. See [AI details](../ai/README.md).

## Try it

Start the API with `npm run dev:api`. In another terminal at the repository root:

```sh
npm run webhook:send
```

This command reads the secret locally, signs a sample, and sends identical bytes twice. It should print `201 accepted`, then `200 duplicate`. Each run generates fresh event/message IDs and leaves one Aisha message and one draft for inspection in DBeaver. `WEBHOOK_URL` can override the local target when testing deployment later.

Run `npm run test:webhook` for the automated checks. They use a newly generated `webhook_test_<random-id>` PostgreSQL schema, with migration history and models explicitly scoped to it. Tests cover signature failures, exact raw bytes/Unicode, validation, retry/conflict behavior, concurrent deliveries, and rollback after a draft-write failure. The generated schema is removed in a cleanup block; application tables are never truncated or dropped.
