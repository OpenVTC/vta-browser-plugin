/**
 * DIDComm v2 protocol — `messagepickup/3.0`.
 *
 * Spec: <https://didcomm.org/messagepickup/3.0/>
 *
 * The wallet uses Pickup 3.0 to retrieve messages queued at its
 * mediator. Two operating modes:
 *
 * - **Polling**: wallet sends `status-request` to check the queue,
 *   then `delivery-request` to receive batches, then
 *   `messages-received` to ACK so the mediator can free them.
 * - **Live mode**: wallet sends `live-delivery-change` with
 *   `live_delivery: true` and the mediator pushes `delivery`
 *   messages immediately when traffic arrives. This is the mode the
 *   library's `MediatorSession` enables on connect.
 *
 * In both modes, the `delivery` envelope carries attachments where
 * each attachment is one inner DIDComm message originally sent
 * through the mediator on the wallet's behalf.
 */

const BASE = "https://didcomm.org/messagepickup/3.0";

export const PickupProtocol = {
  statusRequest: `${BASE}/status-request`,
  status: `${BASE}/status`,
  deliveryRequest: `${BASE}/delivery-request`,
  delivery: `${BASE}/delivery`,
  messagesReceived: `${BASE}/messages-received`,
  liveDeliveryChange: `${BASE}/live-delivery-change`,
} as const;

export type PickupMessageType =
  (typeof PickupProtocol)[keyof typeof PickupProtocol];

// ---------------------------------------------------------------------------
// Message bodies
// ---------------------------------------------------------------------------

export interface StatusRequestBody {
  /** Optional: filter to a specific recipient DID. */
  recipient_did?: string;
}

export interface StatusBody {
  /** Total messages queued. */
  message_count: number;
  /** Optional: count for a specific recipient if filtered. */
  recipient_did?: string;
  longest_waited_seconds?: number;
  newest_received_time?: number;
  oldest_received_time?: number;
  total_bytes?: number;
  live_delivery?: boolean;
}

export interface DeliveryRequestBody {
  /** Maximum number of messages to deliver in this batch. */
  limit: number;
  /** Optional: filter to a specific recipient DID. */
  recipient_did?: string;
}

export interface DeliveryAttachment {
  /** Per-message id — typically the mediator's queue id. Used by
   *  the wallet in `messages-received.message_id_list`. */
  id: string;
  data: {
    /** The full DIDComm JWE as JSON (parsed object), not a string. */
    json: unknown;
  };
}

export interface DeliveryBody {
  recipient_did?: string;
}

/** Spec note: pickup/3.0/delivery's attachments live at the top
 *  level of the Message envelope, not in `body`. The Message struct
 *  in `affinidi-messaging-didcomm` exposes them via `attachments`
 *  (flattened on the wire by serde). */
export interface DeliveryEnvelopeShape {
  type: typeof PickupProtocol.delivery;
  from?: string;
  to?: string[];
  thid?: string;
  body: DeliveryBody;
  attachments: DeliveryAttachment[];
}

export interface MessagesReceivedBody {
  message_id_list: string[];
}

export interface LiveDeliveryChangeBody {
  live_delivery: boolean;
}
