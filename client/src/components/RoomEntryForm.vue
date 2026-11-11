<script setup lang="ts">
import { NameSchema, RoomIdSchema } from "@watch-together/shared";
import { computed, ref } from "vue";
import { useRoomStore } from "../useRoomStore.ts";

const roomStore = useRoomStore();
const name = ref("");
const roomId = new URLSearchParams(window.location.search).get("room");
const validRoomId = roomId === null || RoomIdSchema.safeParse(roomId).success;
const parsedName = computed(() => NameSchema.safeParse(name.value));
const emit = defineEmits<{ beforeEnter: [] }>();

const canSubmit = computed(
  () =>
    validRoomId &&
    parsedName.value.success &&
    roomStore.connection === "online",
);
const errorText = computed(() => {
  const error = roomStore.error;
  if (!error) return null;

  switch (error.code) {
    case "room_not_found":
      return "Комната не найдена. Проверьте ссылку.";
    case "room_full":
      return "Комната заполнена. В ней уже четыре участника.";
    case "rate_limited":
      return "Слишком много попыток. Попробуйте чуть позже.";
    default:
      return roomId === null
        ? "Не удалось создать комнату."
        : "Не удалось войти в комнату.";
  }
});
function submit() {
  const result = parsedName.value;

  if (!result.success || !canSubmit.value) return;
  emit("beforeEnter");
  if (roomId === null) {
    roomStore.createRoom(result.data);
  } else {
    roomStore.joinRoom(roomId, result.data);
  }
}
</script>

<template>
  <section class="room-entry" aria-labelledby="room-entry-title">
    <div class="room-entry-card">
      <h1 id="room-entry-title" class="room-entry-title">Добро пожаловать!</h1>

      <el-form class="room-entry-form" @submit.prevent="submit">
        <el-input
          v-model="name"
          class="room-entry-input"
          placeholder="Введите имя:"
          aria-label="Имя"
        />

        <el-button
          class="room-entry-submit"
          native-type="submit"
          :disabled="!canSubmit"
        >
          {{ roomId === null ? "Создать комнату" : "Присоединиться" }}
        </el-button>
      </el-form>

      <p v-if="!validRoomId" role="alert">Некорректная ссылка на комнату.</p>
      <p v-else-if="errorText" role="alert">{{ errorText }}</p>
    </div>
  </section>
</template>

<style scoped src="../styles/components/RoomEntryForm.css"></style>
