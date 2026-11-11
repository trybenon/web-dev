<script setup lang="ts">
import { ElMessage } from "element-plus";
import type { PlayerBridge, RoomView } from "../sync";
import RoomSettings from "./RoomSettings.vue";
import {
  ref,
  onMounted,
  useTemplateRef,
  watch,
  onBeforeUnmount,
  computed,
} from "vue";
import settingsIcon from "../assets/room/settingsIcon.svg";
import inviteIcon from "../assets/room/inviteIcon.svg";
import exitIcon from "../assets/room/exitIcon.svg";
import exitIconRed from "../assets/room/exitIconRed.svg";
import playIcon from "../assets/room/playIcon.svg";
import pauseIcon from "../assets/room/pauseIcon.svg";
import rewindLeftIcon from "../assets/room/rewindLeftIcon.svg";
import rewindRightIcon from "../assets/room/rewindRightIcon.svg";
import { useRoomStore } from "../useRoomStore.ts";

const emit = defineEmits<{ leave: [] }>();
const props = defineProps<{ room: RoomView | null }>();

const demoUrl = "/media/demo.webm";
const settingsOpen = ref(false);
const roomStore = useRoomStore();
const video = useTemplateRef<HTMLVideoElement>("video");
const videoVolume = ref(100);
let lastAudibleVolume = 100;

function setVideoVolume(value: number): void {
  if (value > 0) lastAudibleVolume = value;

  videoVolume.value = value;
  if (video.value) video.value.volume = value / 100;
}

function toggleVideoVolume(): void {
  setVideoVolume(videoVolume.value === 0 ? lastAudibleVolume : 0);
}
const playback = computed(() => roomStore.state.playback);
const isPaused = computed(() => playback.value?.status === "paused");
const hold = computed(() => roomStore.state.hold);
const showHoldNotice = ref(false);
const secondsLeft = ref(0);
const pauseAuthor = ref("");

watch(
  [
    () => props.room?.roomId,
    () => playback.value?.rev,
    () => (hold.value?.waitingFor.length ? hold.value.deadline : undefined),
  ],
  ([roomId, , deadline], _, onCleanup) => {
    showHoldNotice.value = false;
    if (!roomId || deadline === undefined) return;

    const updateCountdown = () => {
      secondsLeft.value = Math.max(
        0,
        Math.ceil((deadline - roomStore.serverNow()) / 1000),
      );
    };

    let countdownTimer: number | undefined;
    const delayTimer = window.setTimeout(() => {
      updateCountdown();
      showHoldNotice.value = true;
      countdownTimer = window.setInterval(updateCountdown, 250);
    }, 200);

    onCleanup(() => {
      window.clearTimeout(delayTimer);
      window.clearInterval(countdownTimer);
    });
  },
  { immediate: true },
);

watch(
  () => roomStore.state,
  (next, previous) => {
    const { room, playback } = next;

    if (
      !room ||
      room.roomId !== previous.room?.roomId ||
      playback?.status !== "paused"
    ) {
      pauseAuthor.value = "";
      return;
    }

    if (previous.playback && previous.playback.status !== "paused") {
      pauseAuthor.value =
        room.peers.find((peer) => peer.peerId === playback.setBy)?.name ?? "";
    }
  },
  { flush: "sync" },
);

const playbackNotice = computed(() => {
  const currentHold = hold.value;
  if (showHoldNotice.value && currentHold?.waitingFor.length) {
    const names = props.room?.peers
      .filter((peer) => currentHold.waitingFor.includes(peer.peerId))
      .map((peer) => peer.name)
      .join(", ");

    return names ? `Ждём: ${names}` : "Ждём участников";
  }

  if (pauseAuthor.value) return `${pauseAuthor.value} поставил(а) паузу`;

  if (playback.value?.status === "paused" && playback.value.setBy !== null) {
    return "Видео на паузе";
  }

  return "";
});

const durationSeconds = ref(0);
const currentSeconds = ref(0);
const seekPreview = ref<number | null>(null);

function updateTimeline(): void {
  const element = video.value;
  if (!element) return;

  durationSeconds.value = Number.isFinite(element.duration)
    ? element.duration
    : 0;
  currentSeconds.value = element.currentTime;
}

function previewSeek(event: Event): void {
  seekPreview.value = (event.currentTarget as HTMLInputElement).valueAsNumber;
}

function commitSeek(event: Event): void {
  const seconds = (event.currentTarget as HTMLInputElement).valueAsNumber;
  seekPreview.value = null;
  roomStore.seek(Math.round(seconds * 1000));
}

function togglePlayback(): void {
  if (!playback.value) return;

  if (isPaused.value) {
    roomStore.play();
  } else {
    roomStore.pause();
  }
}

function handleSpace(event: KeyboardEvent): void {
  if (
    !props.room ||
    !playback.value ||
    event.code !== "Space" ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return;
  }

  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest("button, input, select, textarea, a"))
  ) {
    return;
  }

  event.preventDefault();
  if (!event.repeat) togglePlayback();
}

function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

let bridge: PlayerBridge | undefined;

function attachPlayer() {
  if (video.value && !bridge) {
    bridge = roomStore.attachPlayer(video.value);
  }
}

function unlockPlayer() {
  attachPlayer();
  void bridge?.unlock();
}

function detachPlayer() {
  bridge?.dispose();
  bridge = undefined;
  if (video.value && !video.value.paused) video.value.pause();
}

onMounted(() => {
  attachPlayer();
  window.addEventListener("keydown", handleSpace);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleSpace);
  detachPlayer();
});

watch(
  () => props.room,
  (room, previousRoom) => {
    if (!room && previousRoom) {
      settingsOpen.value = false;
      seekPreview.value = null;
      detachPlayer();
    }
  },
);

defineExpose({ unlockPlayer });
async function copyInvite() {
  if (!props.room) return;
  const url = new URL("/", window.location.origin);
  url.searchParams.set("room", props.room.roomId);

  try {
    await navigator.clipboard.writeText(url.href);
    ElMessage.success("Ссылка скопирована");
  } catch {
    ElMessage.error("Не удалось скопировать ссылку");
  }
}
</script>

<template>
  <section
    class="room-view"
    :class="{ 'room-view-with-settings': settingsOpen }"
  >
    <div class="room-view-main">
      <div
        class="room-view-screen"
        tabindex="0"
        role="group"
        aria-label="Видеоплеер"
      >
        <video
          ref="video"
          class="room-view-video"
          :src="demoUrl"
          preload="auto"
          playsinline
          @durationchange="updateTimeline"
          @timeupdate="updateTimeline"
          @seeked="updateTimeline"
        />
        <p
          v-if="room"
          class="room-view-demo-credit"
          aria-label="Демонстрационный ролик"
        >
          Grand Theft Auto VI Launch Trailer ·
          <a href="https://www.rockstargames.com/VI/launch-trailer"
            >Rockstar Games</a
          >
        </p>
        <div v-if="room" class="room-view-player-controls">
          <div class="room-view-player-buttons">
            <button
              type="button"
              class="room-view-player-button room-view-player-skip"
              aria-label="Назад на 15 секунд"
              :disabled="!playback || durationSeconds === 0"
              @click="roomStore.seekBy(-15_000, durationSeconds * 1000)"
            >
              <img :src="rewindLeftIcon" alt="" />
            </button>

            <button
              type="button"
              class="room-view-player-button"
              :aria-label="isPaused ? 'Играть' : 'Пауза'"
              :disabled="!playback"
              @click="togglePlayback"
            >
              <img :src="isPaused ? playIcon : pauseIcon" alt="" />
            </button>

            <button
              type="button"
              class="room-view-player-button room-view-player-skip"
              aria-label="Вперёд на 15 секунд"
              :disabled="!playback || durationSeconds === 0"
              @click="roomStore.seekBy(15_000, durationSeconds * 1000)"
            >
              <img :src="rewindRightIcon" alt="" />
            </button>
          </div>

          <div class="room-view-timeline">
            <input
              class="room-view-seek"
              type="range"
              aria-label="Позиция видео"
              min="0"
              :max="durationSeconds"
              step="0.1"
              :value="seekPreview ?? currentSeconds"
              :disabled="!playback || durationSeconds === 0"
              @input="previewSeek"
              @change="commitSeek"
              @pointercancel="seekPreview = null"
            />
            <span class="room-view-time">
              {{ formatTime(seekPreview ?? currentSeconds) }} /
              {{ formatTime(durationSeconds) }}
            </span>
          </div>
        </div>
        <p
          v-if="playbackNotice"
          class="room-view-playback-notice"
          role="status"
        >
          {{ playbackNotice }}
          <span v-if="showHoldNotice && hold" aria-hidden="true">
            · до {{ secondsLeft }} с
          </span>
        </p>
      </div>

      <div class="room-view-toolbar">
        <div class="room-view-toolbar-left">
          <el-tooltip content="Выйти" placement="top" :show-arrow="false">
            <el-button
              class="room-view-action"
              aria-label="Выйти из комнаты"
              @click="emit('leave')"
            >
              <img :src="exitIcon" class="room-view-exit-icon" alt="" />
              <img :src="exitIconRed" class="room-view-exit-icon-red" alt="" />
            </el-button>
          </el-tooltip>

          <el-tooltip
            content="Скопировать ссылку"
            placement="top"
            :show-arrow="false"
          >
            <el-button
              class="room-view-action"
              aria-label="Скопировать ссылку"
              @click="copyInvite"
            >
              <img :src="inviteIcon" alt="" />
            </el-button>
          </el-tooltip>
        </div>

        <el-tooltip content="Настройки" placement="top" :show-arrow="false">
          <span class="room-view-action-trigger">
            <el-button
              class="room-view-action"
              :class="{ 'room-view-action-open': settingsOpen }"
              aria-label="Настройки"
              :aria-expanded="settingsOpen"
              @click="settingsOpen = !settingsOpen"
            >
              <img :src="settingsIcon" alt="" />
            </el-button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <RoomSettings
      v-if="settingsOpen && room"
      :room="room"
      @close="settingsOpen = false"
      :volume="videoVolume"
      @volume-change="setVideoVolume"
      @toggle-volume="toggleVideoVolume"
    />
  </section>
</template>

<style scoped src="../styles/components/RoomView.css"></style>
