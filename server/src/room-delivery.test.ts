import { serverExamples, type ServerMessage } from "@watch-together/shared";
import { describe, expect, it, vi } from "vitest";
import { deliverRoomMessages } from "./room-delivery.js";

function recipient(roomId: string | null) {
  return {
    roomId,
    send: vi.fn<(message: ServerMessage) => void>(),
  };
}

describe("deliverRoomMessages", () => {
  it("sends a personal message only to its recipient", () => {
    const first = recipient("room-1");
    const second = recipient("room-1");
    const message = serverExamples.syncPong;

    const recipients = new Map([
      ["peer-1", first],
      ["peer-2", second],
    ]);

    deliverRoomMessages("room-1", [{ to: "peer-2", msg: message }], recipients);

    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalledExactlyOnceWith(message);
  });

  it("broadcasts only to participants of the specified room", () => {
    const first = recipient("room-1");
    const second = recipient("room-1");
    const outsider = recipient("room-2");
    const message = serverExamples.syncPong;

    const recipients = new Map([
      ["peer-1", first],
      ["peer-2", second],
      ["peer-3", outsider],
    ]);

    deliverRoomMessages("room-1", [{ to: "all", msg: message }], recipients);

    expect(first.send).toHaveBeenCalledExactlyOnceWith(message);
    expect(second.send).toHaveBeenCalledExactlyOnceWith(message);
    expect(outsider.send).not.toHaveBeenCalled();
  });

  it("excludes the specified participant from a broadcast", () => {
    const first = recipient("room-1");
    const second = recipient("room-1");
    const message = serverExamples.syncPong;

    const recipients = new Map([
      ["peer-1", first],
      ["peer-2", second],
    ]);

    deliverRoomMessages(
      "room-1",
      [{ to: "all", except: "peer-1", msg: message }],
      recipients,
    );

    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalledExactlyOnceWith(message);
  });

  it("ignores missing recipients and recipients outside the room", () => {
    const outsider = recipient("room-2");
    const withoutRoom = recipient(null);
    const message = serverExamples.syncPong;

    const recipients = new Map([
      ["peer-2", outsider],
      ["peer-3", withoutRoom],
    ]);

    deliverRoomMessages(
      "room-1",
      [
        { to: "missing-peer", msg: message },
        { to: "peer-2", msg: message },
        { to: "peer-3", msg: message },
        { to: "all", msg: message },
      ],
      recipients,
    );

    expect(outsider.send).not.toHaveBeenCalled();
    expect(withoutRoom.send).not.toHaveBeenCalled();
  });

  it("preserves the order of outgoing messages", () => {
    const client = recipient("room-1");
    const firstMessage = serverExamples.roomState;
    const secondMessage = serverExamples.sourceState;

    const recipients = new Map([["peer-1", client]]);

    deliverRoomMessages(
      "room-1",
      [
        { to: "peer-1", msg: firstMessage },
        { to: "all", msg: secondMessage },
      ],
      recipients,
    );

    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.send).toHaveBeenNthCalledWith(1, firstMessage);
    expect(client.send).toHaveBeenNthCalledWith(2, secondMessage);
  });
});
