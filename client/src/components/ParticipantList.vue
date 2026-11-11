<script setup lang="ts">
import { computed } from "vue";
import type { PeerView, RoomView } from "../sync";

const props = defineProps<{
  peers: RoomView["peers"];
  you: RoomView["you"];
}>();

function getStatus(peer: PeerView): string | null {
  if (peer.connection === "reconnecting") {
    return "Переподключается";
  }

  const presence = peer.presence;
  if (!presence?.hasSource) return null;

  if (presence.playerState === "seeking") {
    return "Синхронизация";
  }

  if (presence.playerState === "buffering" || presence.readyState < 3) {
    return "Загружается";
  }

  const delay = presence.deviationMs;
  if (delay !== null && delay >= 1000) {
    return `Отстаёт на ${Math.round(delay / 1000)} с`;
  }

  return "Готов";
}

const participants = computed(() =>
  props.peers.map((peer) => ({ peer, status: getStatus(peer) })),
);
</script>

<template>
  <h2 class="participant-list-title">Участники</h2>

  <ul class="participant-list">
    <li
      v-for="{ peer, status } in participants"
      :key="peer.peerId"
      class="participant-list-row"
    >
      <span>
        {{ peer.name }}<template v-if="peer.peerId === you"> (вы)</template>
      </span>
      <span v-if="status" class="participant-list-status">{{ status }}</span>
    </li>
  </ul>
</template>

<style scoped src="../styles/components/ParticipantList.css"></style>
