import type { PeerId, RoomId } from "@watch-together/shared";
import type { Outbound } from "./room.js";
import type { GatewayClient } from "./ws-gateway.js";

type RoomRecipient = Pick<GatewayClient, "roomId" | "send">;

export function deliverRoomMessages(
  roomId: RoomId,
  messages: readonly Outbound[],
  recipients: ReadonlyMap<PeerId, RoomRecipient>,
): void {
  for (const outbound of messages) {
    if (outbound.to === "all") {
      for (const [peerId, client] of recipients) {
        if (client.roomId === roomId && peerId !== outbound.except) {
          client.send(outbound.msg);
        }
      }

      continue;
    }

    const client = recipients.get(outbound.to);

    if (client?.roomId === roomId) {
      client.send(outbound.msg);
    }
  }
}
