"""Sample only this comparison's descendants. Persist roles and counters,
never command lines or environments. schedstat runtime is in nanoseconds.
"""
import json
import os
import pathlib
import signal
import sys
import time

root, output, helper_cpus = int(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
os.sched_setaffinity(0, {int(cpu) for cpu in helper_cpus.split(',')})
stopping = False


def stop(*_):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
known = {}
registered = {}
group = None
with output.open('x') as stream:
    while not stopping:
        started = time.monotonic()
        group_file = output.with_name('box.path')
        if group_file.exists():
            group = group_file.read_text().strip()
        roles = output.with_name('roles.jsonl')
        if roles.exists():
            for line in roles.read_text().splitlines():
                try:
                    item = json.loads(line)
                    registered[item['pid']] = item['role']
                except (ValueError, KeyError):
                    pass  # A concurrent append can leave a partial last line.
        processes = {}
        for entry in pathlib.Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                stat = (entry / 'stat').read_text()
                fields = stat[stat.rindex(')') + 2:].split()
                processes[int(entry.name)] = (int(fields[1]), fields[19])
            except (OSError, ValueError):
                pass
        own = {root}
        while True:
            added = {pid for pid, (parent, _) in processes.items() if parent in own}
            if added <= own:
                break
            own |= added
        for pid in own - {os.getpid()}:
            if pid not in processes:
                continue
            try:
                proc = pathlib.Path('/proc', str(pid))
                cmd = (proc / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
                if pid in registered:
                    role = registered[pid]
                elif 'test/e2e/library-server.ts' in cmd:
                    role = 'server'
                elif 'test/fake-ollama/main.ts' in cmd:
                    role = 'fake'
                elif 'fake-ollama/nvidia-smi.' in cmd or 'test/perf/gpu-helper.sh' in cmd:
                    role = 'gpu'
                elif 'chrome-headless-shell' in cmd or '/chromium' in cmd or '/chrome ' in cmd:
                    role = 'renderer' if '--type=renderer' in cmd else 'browser-other'
                elif 'vite' in cmd and 'preview' in cmd:
                    role = 'unassigned'
                elif any(name in cmd for name in ('playwright', 'test/perf/stack.ts', 'pnpm')):
                    role = 'driver'
                else:
                    role = 'unassigned'
                cgroup = '/sys/fs/cgroup' + (proc / 'cgroup').read_text().strip().split(':')[-1]
                known[pid] = (processes[pid][1], role, cgroup == group, sorted(os.sched_getaffinity(pid)))
            except OSError:
                pass
        rows = []
        for pid, (birth, role, boxed, affinity) in list(known.items()):
            try:
                # A recycled PID must not inherit the previous process's counters.
                stat = pathlib.Path(f'/proc/{pid}/stat').read_text()
                if stat[stat.rindex(')') + 2:].split()[19] != birth:
                    continue
                tasks = list(pathlib.Path(f'/proc/{pid}/task').iterdir())
            except OSError:
                continue
            for task in tasks:
                try:
                    runtime, _, _ = map(int, (task / 'schedstat').read_text().split())
                    placed = 'page' if role == 'renderer' and int(task.name) == pid else 'browser-other' if role == 'renderer' else role
                    rows.append([pid, birth, int(task.name), placed, runtime, boxed, affinity])
                except (OSError, ValueError):
                    pass
        box_cpu = None
        if group:
            try:
                counters = dict(line.split() for line in pathlib.Path(group, 'cpu.stat').read_text().splitlines())
                box_cpu = int(counters['usage_usec']) * 1000
            except OSError:
                pass
        stream.write(json.dumps({'epochMs': time.time_ns() / 1e6, 'scanMs': (time.monotonic() - started) * 1000,
                                 'rows': rows, 'boxCpuNs': box_cpu}, separators=(',', ':')) + '\n')
        stream.flush()
        time.sleep(max(0, .01 - (time.monotonic() - started)))
