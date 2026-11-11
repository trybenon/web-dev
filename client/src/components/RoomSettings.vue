<script setup lang="ts">
import type { RoomView } from "../sync";
import ParticipantList from "./ParticipantList.vue";
import soundIcon from "../assets/room/soundIcon.svg";
import soundOffIcon from "../assets/room/soundOffIcon.svg";

defineProps<{ room: RoomView; volume: number }>();

const emit = defineEmits<{
  close: [];
  volumeChange: [value: number];
  toggleVolume: [];
}>();

function updateVolume(value: number | number[]): void {
  if (typeof value === "number") emit("volumeChange", value);
}
</script>

<template>
  <aside class="room-settings" aria-label="Настройки комнаты">
    <el-button
      class="room-settings-close"
      text
      aria-label="Закрыть настройки"
      @click="emit('close')"
    >
      ×
    </el-button>

    <ParticipantList :peers="room.peers" :you="room.you" />
    <div class="room-settings-volume">
      <span>Громкость видео</span>

      <button
        type="button"
        class="room-settings-sound"
        :aria-label="
          volume === 0 ? 'Включить звук видео' : 'Выключить звук видео'
        "
        @click="emit('toggleVolume')"
      >
        <img :src="volume === 0 ? soundOffIcon : soundIcon" alt="" />
      </button>

      <div class="room-settings-volume-control">
        <el-slider
          class="room-settings-volume-slider"
          aria-label="Громкость видео"
          :model-value="volume"
          :show-tooltip="false"
          @update:model-value="updateVolume"
        />

        <div class="room-settings-volume-guide" aria-hidden="true">
          <span
            class="room-settings-volume-tip"
            :style="{ insetInlineStart: `${volume}%` }"
          >
            {{ volume }}%
          </span>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped src="../styles/components/RoomSettings.css"></style>
