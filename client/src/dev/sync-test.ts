/**
 * Служебная страница проверки синхронизации (client/sync-test.html).
 * Подключает настоящий SyncClient и мост к обычному video без интерфейса
 * приложения: два окна, один файл, общий старт, пауза и перемотка.
 */
import {
  createPlayerBridge,
  createSyncClient,
  positionAt,
  type SyncState,
} from "../sync";

const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const video = byId<HTMLVideoElement>("video");
const nameInput = byId<HTMLInputElement>("name");
const roomInput = byId<HTMLInputElement>("room");
const fileInput = byId<HTMLInputElement>("file");
const link = byId<HTMLAnchorElement>("link");
const status = byId<HTMLPreElement>("status");

const params = new URLSearchParams(location.search);
// ?ws=адрес — подключиться в обход прокси Vite, например чтобы проверить обрыв
const client = createSyncClient({ url: params.get("ws") ?? undefined });
const bridge = createPlayerBridge(client, video);
const DEMO = "/media/demo.webm";

roomInput.value = params.get("room") ?? "";
video.src = DEMO;

const name = () => nameInput.value.trim() || "Гость";

// вход — только по клику: в нём же снимаем запрет на звук (decisions.md, 4.10)
byId("create").addEventListener("click", () => {
  void bridge.unlock();
  client.createRoom(name());
});
byId("join").addEventListener("click", () => {
  void bridge.unlock();
  client.joinRoom(roomInput.value.trim(), name());
});
byId("leave").addEventListener("click", () => client.leaveRoom());
byId("play").addEventListener("click", () => client.play());
byId("pause").addEventListener("click", () => client.pause());
byId("back").addEventListener("click", () => seekBy(-10_000));
byId("forward").addEventListener("click", () => seekBy(10_000));
byId("demo").addEventListener("click", () => {
  video.src = DEMO;
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) video.src = URL.createObjectURL(file);
});

function seekBy(deltaMs: number): void {
  const playback = client.getState().playback;
  if (!playback) return;
  const now = positionAt(playback, client.serverNow());
  // источник здесь не выбирается, и сервер не знает длину ролика: у самого
  // конца он ждал бы 2 с буфера, которых нет, — не подходим к концу ближе 3 с
  const lastMs = Number.isFinite(video.duration)
    ? Math.max(0, video.duration * 1000 - 3_000)
    : Infinity;
  client.seek(Math.min(Math.max(0, now + deltaMs), lastMs));
}

function log(text: string): void {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  byId("log").prepend(item);
}

client.onError((error) => log(`ошибка ${error.code}: ${error.message}`));
video.addEventListener("error", () => log(`видео не открылось: ${video.src}`));

const seconds = (ms: number) => (ms / 1000).toFixed(2);

function render(state: SyncState): void {
  const lines = [`связь: ${state.connection}`];
  const { room, playback, hold } = state;
  if (room) {
    const url = `${location.origin}${location.pathname}?room=${room.roomId}`;
    link.href = url;
    link.textContent = `Ссылка для второго окна: ${url}`;
    lines.push(`комната ${room.roomId}`);
    for (const peer of room.peers) {
      const me = peer.peerId === room.you ? " (я)" : "";
      const p = peer.presence;
      const report = p
        ? `${p.playerState}, готов к rev ${p.appliedRev}, буфер ${seconds(p.bufferedAheadMs)} с, отклонение ${p.deviationMs ?? "—"} мс, rtt ${p.rttMs} мс`
        : "отчёта ещё нет";
      lines.push(`  ${peer.name}${me} — ${peer.connection}, ${report}`);
    }
  } else {
    link.removeAttribute("href");
    link.textContent = "";
  }
  if (playback) {
    const roomAt = positionAt(playback, client.serverNow());
    lines.push(
      `воспроизведение: ${playback.status}, rev ${playback.rev}, комната на ${seconds(roomAt)} с, плеер на ${video.currentTime.toFixed(2)} с, скорость ×${video.playbackRate.toFixed(3)}`,
    );
  }
  if (hold) {
    const left = Math.max(0, hold.deadline - client.serverNow());
    lines.push(
      `ждём: ${hold.waitingFor.join(", ")} (${hold.reason}), ещё ${seconds(left)} с`,
    );
  }
  status.textContent = lines.join("\n");
}

client.subscribe(render);
setInterval(() => render(client.getState()), 250);

// для e2e-теста: состояние и плеер видны снаружи
Object.assign(window, { syncTest: { client, video } });
