import { fingerprintFile, videoDurationMs } from "./fingerprint.mjs";

const input = document.querySelector("#file");
const status = document.querySelector("#status");
const results = document.querySelector("#results");

input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;
  input.disabled = true;
  results.hidden = true;
  status.className = "hint";
  status.textContent = "Читаю длительность видео…";
  const totalStart = performance.now();
  try {
    const metadataStart = performance.now();
    const durationMs = await videoDurationMs(file);
    const metadataTimeMs = Math.round(performance.now() - metadataStart);
    status.textContent = "Считаю хеши трёх фрагментов…";
    const { fingerprint, hashTimeMs, bytesRead } = await fingerprintFile(file, durationMs);
    const totalTimeMs = Math.round(performance.now() - totalStart);
    document.querySelector("#file-info").textContent = `${file.name} · ${file.size} байт · ${durationMs} мс`;
    document.querySelector("#timings").replaceChildren(
      ...[
        ["Метаданные", metadataTimeMs + " мс"],
        ["Чтение и SHA-256", hashTimeMs + " мс"],
        ["Всего", totalTimeMs + " мс"],
        ["Прочитано", bytesRead + " байт"],
      ].map(([name, value]) => {
        const row = document.createElement("tr");
        const label = document.createElement("th");
        label.style.textAlign = "left";
        const data = document.createElement("td");
        label.textContent = name;
        data.textContent = value;
        row.append(label, data);
        return row;
      }),
    );
    document.querySelector("#fingerprint").textContent = JSON.stringify(fingerprint, null, 2);
    results.hidden = false;
    status.textContent = "Готово. Повторите выбор того же файла для проверки стабильности результата.";
  } catch (error) {
    status.className = "error";
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    input.disabled = false;
    input.value = "";
  }
});
