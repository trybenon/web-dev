<script setup lang="ts">
import { useRoomStore } from "./useRoomStore.ts";
import RoomEntryForm from "./components/RoomEntryForm.vue";
import RoomView from "./components/RoomView.vue";
import { useTemplateRef } from "vue";

const roomStore = useRoomStore();
const roomView = useTemplateRef<InstanceType<typeof RoomView>>("roomView");
function leaveRoom(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  window.history.replaceState(window.history.state, "", url);

  roomStore.leaveRoom();
}
</script>

<template>
  <main>
    <RoomEntryForm
      v-if="!roomStore.room"
      @before-enter="roomView?.unlockPlayer()"
    />

    <RoomView
      v-show="roomStore.room !== null"
      ref="roomView"
      :room="roomStore.room"
      @leave="leaveRoom"
    />
  </main>
</template>
