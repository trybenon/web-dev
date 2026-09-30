// Рабочий поток для проверки фоновой вкладки.
// Тикает каждые 100 мс, запоминает моменты тиков (в абсолютной шкале
// timeOrigin + now, общей с окном) и раз в 500 мс шлёт окну сообщение,
// чтобы проверить, как быстро скрытое окно их получает.
const ticks = [];
const abs = () => performance.timeOrigin + performance.now();

setInterval(() => {
  ticks.push(abs());
  if (ticks.length > 20000) ticks.splice(0, 10000);
}, 100);

setInterval(() => postMessage({ type: 'beat', sentAt: abs() }), 500);

onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'hello') postMessage({ type: 'hello', timeOrigin: performance.timeOrigin, now: performance.now() });
  if (m.type === 'stats') {
    const inRange = ticks.filter((t) => t >= m.from && t <= m.to);
    let maxGap = 0;
    for (let i = 1; i < inRange.length; i++) maxGap = Math.max(maxGap, inRange[i] - inRange[i - 1]);
    postMessage({ type: 'stats', id: m.id, count: inRange.length, maxGap });
  }
};
