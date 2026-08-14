#st
from state import state


def _is_mod_or_broadcaster(login: str, badges: list) -> bool:
    names = {b.get("name") for b in (badges or [])}
    return "moderator" in names or "broadcaster" in names


def _is_subscriber(badges: list) -> bool:
    names = {b.get("name") for b in (badges or [])}
    return bool(names & {"subscriber", "founder", "vip"})


def check_conditions(cfg: dict, login: str, badges: list | None) -> bool:
    conditions = cfg.get("conditions") or {}
    if not conditions:
        return True

    username = conditions.get("username")
    if username and login.lower() != username.lower():
        return False

    if badges is not None:
        if conditions.get("moderator") and not _is_mod_or_broadcaster(login, badges):
            return False
        if conditions.get("subscriber") and not _is_subscriber(badges):
            return False

    min_flags = conditions.get("min_flags")
    if min_flags:
        flags = state.data.get("flags", {})
        if flags.get(login.lower(), 0) < min_flags:
            return False

    return True
