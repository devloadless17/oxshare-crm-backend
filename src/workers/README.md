# Workers

BullMQ job processors — all run on the same container image as the API with a different entrypoint.

## Queue definitions (ARCHITECTURE.md §9)

| Queue | Trigger | Notes |
|---|---|---|
| `mt5.ingest` | Webhook + sweep | Idempotent insert via `ON CONFLICT (mt5_ticket) DO NOTHING` |
| `mt5.sweep` | Repeatable, every 5 min | 24h lookback window |
| `commission.accrue` | `deal.closed` event | Idempotent per `(deal_id, ib_user_id, level)` |
| `commission.confirm` | Repeatable, every 60s | Promotes matured accruals to wallet |
| `payments.callback` | Provider webhook | Signature verified first |
| `mail.send` | Various | Retry with exponential backoff |

Every job must be **safe to run twice**. Assume at-least-once delivery.
