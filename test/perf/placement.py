"""Place owned performance children before their runtime starts."""
import os
import pathlib
import signal
import sys


def current_group():
    return pathlib.Path('/sys/fs/cgroup' + pathlib.Path('/proc/self/cgroup').read_text().strip().split(':')[-1])


mode, *command = sys.argv[1:]
if mode == 'hold':
    pathlib.Path(command[0]).write_text(str(current_group()))
    signal.pause()
    sys.exit(0)
if mode == 'driver':
    group = str(current_group())
    os.environ['GL_PERF_HELPER_GROUP'] = group
    pathlib.Path(os.environ['GL_PERF_OUT'], 'helpers.path').write_text(group)
    if not os.environ.get('GL_PERF_APP_GROUP'):
        pathlib.Path(os.environ['GL_PERF_OUT'], 'box.path').write_text(group)
elif mode == 'app':
    group = os.environ.get('GL_PERF_APP_GROUP')
    if group:
        pathlib.Path(group, 'cgroup.procs').write_text(str(os.getpid()))
        os.sched_setaffinity(0, set(range(int(os.environ['GL_PERF_APP_CORES']))))
else:
    raise ValueError('Unknown performance placement mode')
os.execvp(command[0], command)
