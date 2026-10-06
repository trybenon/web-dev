/**
 * Запись результата конвертации в приватное хранилище браузера (OPFS).
 *
 * Почему отдельный воркер: синхронный доступ к файлу OPFS
 * (createSyncAccessHandle) есть во всех трёх браузерах, но только в воркере.
 * Асинхронный createWritable в Safari появился лишь в версии 26, а в Safari 18
 * его нет. Так один путь записи работает везде, и гигабайты не держатся в памяти.
 */

interface SyncHandle {
  write(data: BufferSource, opts: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
  getSize(): number;
}

let handle: SyncHandle | null = null;

type In =
  | { type: 'open'; name: string }
  | { type: 'write'; id: number; data: Uint8Array<ArrayBuffer>; position: number }
  | { type: 'close' };

self.onmessage = async (ev: MessageEvent<In>) => {
  const m = ev.data;
  try {
    if (m.type === 'open') {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(m.name, { create: true });
      handle = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      handle.truncate(0);
      postMessage({ type: 'opened' });
    } else if (m.type === 'write') {
      if (!handle) throw new Error('файл не открыт');
      const n = handle.write(m.data, { at: m.position });
      if (n !== m.data.byteLength) throw new Error(`записано ${n} байт из ${m.data.byteLength}`);
      postMessage({ type: 'written', id: m.id });
    } else if (m.type === 'close') {
      const size = handle ? handle.getSize() : 0;
      handle?.flush();
      handle?.close();
      handle = null;
      postMessage({ type: 'closed', size });
    }
  } catch (err) {
    const e = err as Error;
    postMessage({ type: 'error', name: e.name, message: e.message, id: (m as { id?: number }).id });
  }
};
