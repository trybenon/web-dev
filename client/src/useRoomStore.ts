import { defineStore } from "pinia";
import { computed, onScopeDispose, shallowRef } from "vue";
import {
  createPlayerBridge,
  createSyncClient,
  positionAt,
  type SyncError,
} from "./sync";

export const useRoomStore = defineStore("room", () => {
  const client = createSyncClient();
  const state = shallowRef(client.getState());
  const error = shallowRef<SyncError | null>(null);

  const unsubscribeState = client.subscribe((nextState) => {
    state.value = nextState;
  });

  const unsubscribeError = client.onError((nextError) => {
    error.value = nextError;
  });

  const room = computed(() => state.value.room);
  const connection = computed(() => state.value.connection);

  function createRoom(name: string): void {
    error.value = null;
    client.createRoom(name.trim());
  }

  function joinRoom(roomId: string, name: string): void {
    error.value = null;
    client.joinRoom(roomId, name.trim());
  }
  function leaveRoom(): void {
    error.value = null;
    client.leaveRoom();
  }

  function attachPlayer(video: HTMLVideoElement) {
    return createPlayerBridge(client, video);
  }

  function play(): void {
    client.play();
  }

  function pause(): void {
    client.pause();
  }

  function seek(positionMs: number): void {
    client.seek(positionMs);
  }

  function seekBy(deltaMs: number, durationMs: number): void {
    const playback = state.value.playback;
    if (!playback || durationMs <= 0) return;

    const currentMs = positionAt(playback, client.serverNow());
    const targetMs = Math.min(durationMs, Math.max(0, currentMs + deltaMs));
    seek(Math.round(targetMs));
  }

  function serverNow(): number {
    return client.serverNow();
  }

  onScopeDispose(() => {
    unsubscribeState();
    unsubscribeError();
    client.dispose();
  });

  return {
    state,
    room,
    connection,
    error,
    createRoom,
    joinRoom,
    leaveRoom,
    attachPlayer,
    play,
    pause,
    seek,
    seekBy,
    serverNow,
  };
});
