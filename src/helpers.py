import os
import pathlib
import subprocess
import time

from config import log
from state import state


def write_atomic(path: pathlib.Path, content: str) -> None:
    tmp = str(path) + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, str(path))
    except Exception as e:
        log.warning("_write_atomic %s: %s", path, e)


def write_bytes_atomic(path: pathlib.Path, data: bytes) -> None:
    tmp = str(path) + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, str(path))
    except Exception as e:
        log.warning("_write_bytes_atomic %s: %s", path, e)


def get_cpu() -> str:
    try:
        import psutil
        return f"{psutil.cpu_percent(interval=0.15):.0f}%"
    except Exception:
        return "n/a"


def get_mem() -> str:
    try:
        import psutil
        vm = psutil.virtual_memory()
        used_gb = vm.used / 1024 ** 3
        return f"{used_gb:.1f}G ({vm.percent:.0f}%)"
    except Exception:
        return "n/a"


def get_gpu() -> str:
    try:
        import GPUtil
        gpus = GPUtil.getGPUs()
        if gpus:
            return f"{gpus[0].load * 100:.0f}%"
    except Exception:
        pass
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=utilization.gpu",
             "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL, timeout=2,
        ).decode().strip()
        return f"{out}%"
    except Exception:
        pass
    return "n/a"


def get_uptime() -> str:
    try:
        import psutil
        boot = psutil.boot_time()
        delta = int(time.time() - boot)
        h, m = divmod(delta // 60, 60)
        return f"{h}h {m}m" if h else f"{m}m"
    except Exception:
        return "n/a"


def get_wpm() -> str:
    now = time.monotonic()
    with state.wpm_lock:
        while state.keypress_times and state.keypress_times[0] < now - 60:
            state.keypress_times.popleft()
        return f"{len(state.keypress_times) // 5} wpm"
