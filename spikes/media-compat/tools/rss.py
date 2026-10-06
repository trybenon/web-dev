"""Пиковая память браузера во время замера (только Linux: читает /proc).

Раз в 2 с суммирует RSS всех процессов, в командной строке которых есть
подстрока (по умолчанию «chrom» — Chromium и Chrome), пока жив процесс
tools/bench.mjs. В конце пишет строку PEAK_MB.

Запуск — во втором терминале, сразу после `npm run bench`:
    python3 tools/rss.py results/rss.log
    python3 tools/rss.py results/rss.log pw-browsers   # только Chromium из Playwright

Так получено число «около 1,4 ГБ» в docs/spikes/media-compat.md
(results/memory-2026-10-06.txt).
"""
import os
import sys
import time

out_path = sys.argv[1]
needle = sys.argv[2] if len(sys.argv) > 2 else 'chrom'
peak = 0
with open(out_path, 'w') as out:
    while True:
        total = 0
        bench = False
        for pid in os.listdir('/proc'):
            if not pid.isdigit():
                continue
            try:
                cmd = open(f'/proc/{pid}/cmdline', 'rb').read().decode('utf-8', 'replace')
                if 'tools/bench.mjs' in cmd:
                    bench = True
                if needle in cmd and 'rss.py' not in cmd:
                    for line in open(f'/proc/{pid}/status'):
                        if line.startswith('VmRSS:'):
                            total += int(line.split()[1])
            except OSError:
                pass
        peak = max(peak, total)
        out.write(f'{time.time():.0f} {total // 1024}\n')
        out.flush()
        if not bench and total == 0 and peak > 0:
            break
        time.sleep(2)
    out.write(f'PEAK_MB {peak // 1024}\n')
