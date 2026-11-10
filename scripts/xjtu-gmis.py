#!/usr/bin/env python3
# xjtu-gmis.py — XJTU GMIS (研究生管理信息系统) timetable → Pulse `courses` events.
#
# The ehall「我的课表」app used by xjtu-timetable-calendar is the *undergrad*
# teaching system — CAS denies grad students ("Required Access Policy not
# matched"). Grad schedules live in GMIS instead: a server-rendered page with
# course data embedded in JS. This script mirrors the ehall tool's UX:
#
#   login   headed browser, manual SSO → save storage_state (like xjtu-calendar login)
#   fetch   pull the schedule HTML snapshot (cookie session; falls back to cache)
#   events  cached HTML → expand 星期+节次+周次 → {events:[...]} JSON on stdout
#   pull    fetch + events in one go — what sync-courses.mjs calls
#   doctor  read-only setup check (session / calendar / schedule configs)
#
# Stdlib only — except `login`, which needs playwright:
#   uv run --with playwright python3 scripts/xjtu-gmis.py login
#
# Calendar config is SHARED with xjtu-timetable-calendar (no double config):
#   $XJTU_CALENDAR_HOME/semesters/<key>.json   (first_week_monday, excluded_dates, overrides)
#   $XJTU_CALENDAR_HOME/schedules/schedule.json (period times, winter/summer switch)
#
# Env: XJTU_GMIS_HOME (default ~/.xjtu-gmis), XJTU_CALENDAR_HOME
# (default ~/.xjtu-timetable-calendar), XJTU_SEMESTER (e.g. 2026-fall).

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta
from pathlib import Path

GMIS_BASE = "https://gmis.xjtu.edu.cn"
SCHEDULE_PAGE = f"{GMIS_BASE}/pyxx/pygl/xskbcx"
TERM_PARAM = "index"  # /pyxx/pygl/xskbcx/index/<option value>
SHANGHAI = "+08:00"


def warn(msg):
    print(f"[xjtu-gmis] {msg}", file=sys.stderr)


def die(msg, code=1):
    warn(msg)
    sys.exit(code)


def gmis_home() -> Path:
    return Path(os.environ.get("XJTU_GMIS_HOME", Path.home() / ".xjtu-gmis"))


def cal_home() -> Path:
    return Path(os.environ.get("XJTU_CALENDAR_HOME", Path.home() / ".xjtu-timetable-calendar"))


def session_path() -> Path:
    return gmis_home() / "session" / "storage_state.json"


def raw_path(term: str) -> Path:
    return gmis_home() / "raw" / f"schedule-{term}.json"


def default_semester() -> str:
    m, y = date.today().month, date.today().year
    if m >= 8:
        return f"{y}-fall"
    if m == 1:
        return f"{y - 1}-fall"
    return f"{y}-spring"


def semester_key(args) -> str:
    return args.semester or os.environ.get("XJTU_SEMESTER") or default_semester()


# ── Term mapping: our file key ↔ GMIS's "YYYY秋/YYYY春" option name ─────────
def key_to_term(key: str) -> str:
    m = re.fullmatch(r"(\d{4})-(fall|spring)", key)
    if not m:
        die(f"学期标识 {key!r} 不符合 <year>-fall/-spring，无法映射到 GMIS 学期名；用 --semester 传对得上的 key，或自行换算")
    return f"{m.group(1)}{'秋' if m.group(2) == 'fall' else '春'}"


# ── Config loaders (shared format with xjtu-timetable-calendar) ────────────
def load_semester_config(key: str, override: str | None) -> dict:
    path = Path(override) if override else cal_home() / "semesters" / f"{key}.json"
    if not path.is_file():
        die(f"缺少学期校历配置 {path} —— 按官方校历填 semester.first_week_monday（第 1 教学周的星期一）")
    cfg = json.loads(path.read_text("utf-8"))
    sem = cfg.get("semester", {})
    if sem.get("key") and sem["key"] != key:
        warn(f"校历配置 key={sem['key']!r} 与请求的 {key!r} 不一致（文件名即身份）")
    if not sem.get("first_week_monday"):
        die(f"{path} 缺少 semester.first_week_monday")
    return cfg


def load_schedule_config(override: str | None) -> dict:
    path = Path(override) if override else cal_home() / "schedules" / "schedule.json"
    if not path.is_file():
        die(f"缺少作息表配置 {path} —— 从 xjtu-timetable-calendar 的 examples/schedule.example.json 抄（已是西交真实作息）")
    return json.loads(path.read_text("utf-8"))


def profile_for(cfg: dict, day: date) -> dict | None:
    """作息表生效区间 → profile（{'1': (start,end), ...}）。找不到返回 None。"""
    for span in cfg.get("periods", []):
        if date.fromisoformat(span["start"]) <= day <= date.fromisoformat(span["end"]):
            return cfg["profiles"].get(span["profile"])
    return None


# ── GMIS schedule page parsing (ported from XJTUToolBox gmis/schedule_parser) ─
# The page writes course info into td_<weekday>_<period> cells via JS; the
# `节次` text inside is authoritative (a 3-4 节 class lands in the row-3 cell).
CELL_RE = re.compile(
    r'document\.getElementById\("td_(\d+)_(\d+)"\);\s*'
    r'if\s*\(td\.innerHTML!=""\)\s*td\.innerHTML\+="<br><br>";\s*'
    r'td\.innerHTML\+="([^"]+)";',
    re.DOTALL,
)
FIELD_RES = {k: re.compile(v + r'：([^<]+)') for k, v in {
    "name": "课程", "teacher": "教师", "room": "教室",
    "periods": "节次", "weeks": "周次",
}.items()}


def parse_weeks(text: str) -> list[int]:
    """'1-16周' / '第9-16周' / '3周' / '1,3,5-8周' / '1-15单周' / '双周2-16' → sorted week list."""
    t = re.sub(r"[周次节第\s]", "", text)
    odd_only = "单" in t
    even_only = "双" in t
    t = t.replace("单", "").replace("双", "")
    weeks: set[int] = set()
    for part in re.split(r"[,，、/]", t):
        if not part:
            continue
        m = re.fullmatch(r"(\d+)-(\d+)", part) or re.fullmatch(r"(\d+)", part)
        if not m:
            warn(f"周次片段 {part!r} 无法解析，已跳过（原文 {text!r}）")
            continue
        if m.lastindex == 2:
            a, b = int(m.group(1)), int(m.group(2))
            weeks.update(range(min(a, b), max(a, b) + 1))
        else:
            weeks.add(int(m.group(1)))
    if odd_only:
        weeks = {w for w in weeks if w % 2 == 1}
    if even_only:
        weeks = {w for w in weeks if w % 2 == 0}
    return sorted(weeks)


def parse_periods(text: str) -> tuple[int, int] | None:
    t = re.sub(r"[节\s]", "", text)
    m = re.fullmatch(r"(\d+)-(\d+)", t) or re.fullmatch(r"(\d+)", t)
    if not m:
        warn(f"节次 {text!r} 无法解析")
        return None
    a, b = int(m.group(1)), int(m.group(2) if m.lastindex == 2 else m.group(1))
    return (min(a, b), max(a, b))


def parse_schedule_html(html_text: str) -> list[dict]:
    """→ [{'name','teacher','room','day_of_week','period_start','period_end','weeks','raw'}]"""
    meetings = []
    seen = set()
    for dow, _row, text in CELL_RE.findall(html_text):
        fields = {}
        for k, rx in FIELD_RES.items():
            m = rx.search(text)
            if not m:
                break
            fields[k] = m.group(1).strip()
        else:
            span = parse_periods(fields["periods"])
            weeks = parse_weeks(fields["weeks"])
            if not span or not weeks:
                continue
            key = (dow, fields["periods"], fields["weeks"], fields["name"])
            if key in seen:
                continue
            seen.add(key)
            meetings.append({
                "name": fields["name"], "teacher": fields["teacher"],
                "room": fields["room"], "day_of_week": int(dow),
                "period_start": span[0], "period_end": span[1],
                "weeks": weeks,
                "raw": f"{fields['periods']}节 {fields['weeks']}",
            })
            continue
        warn(f"课程字段不完整，已跳过：{text!r}")
    return meetings


def parse_term_options(html_text: str) -> dict[str, str]:
    """<select id="drpxq"> option text → value（学期切换下拉框）。"""
    sel = re.search(r'<select[^>]*id="drpxq"[^>]*>(.*?)</select>', html_text, re.DOTALL | re.I)
    if not sel:
        return {}
    return {t.strip(): v for v, t in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)</option>', sel.group(1))}


def parse_selected_term(html_text: str) -> str | None:
    m = re.search(r'<option[^>]*selected[^>]*>([^<]*)</option>', html_text, re.I)
    return m.group(1).strip() if m else None


def source_week_day(fwm: date, d: date) -> tuple[int, int]:
    delta = (d - fwm).days
    return delta // 7 + 1, delta % 7 + 1


def expand(meetings: list[dict], sem_cfg: dict, sched_cfg: dict, key: str) -> list[dict]:
    fwm = date.fromisoformat(sem_cfg["semester"]["first_week_monday"])
    if fwm.weekday() != 0:
        die(f"{key}: first_week_monday {fwm} 不是星期一")
    excluded = {date.fromisoformat(d) for d in sem_cfg.get("excluded_dates", [])}
    overrides = {date.fromisoformat(k): v for k, v in sem_cfg.get("overrides", {}).items()}
    unsupported = [u for u in sem_cfg.get("unsupported_adjustments", [])
                   if date.fromisoformat(u["date"])]
    if unsupported:
        warn(f"{key}: 有 {len(unsupported)} 条工具无法表达的调课声明，对应日期按正常课表展开")

    events = []
    # (date, weekday) → meetings from that (week, weekday). Overrides add a
    # second pass: target date D inherits source date S's weekday meetings.
    def emit(m: dict, d: date):
        prof = profile_for(sched_cfg, d)
        if prof is None:
            warn(f"{d} 不在任何作息区间内，跳过 {m['name']}")
            return
        try:
            t_start = prof["periods"][str(m["period_start"])][0]
            t_end = prof["periods"][str(m["period_end"])][1]
        except KeyError:
            warn(f"{d} 作息表缺少第 {m['period_start']}-{m['period_end']} 节，跳过 {m['name']}")
            return
        uid_src = f"{key}|{m['name']}|{d.isoformat()}|{m['period_start']}-{m['period_end']}"
        uid = hashlib.sha256(uid_src.encode()).hexdigest()[:32] + "@xjtu-gmis"
        desc = f"教师: {m['teacher']}\n{m['raw']}"
        if m.get("note"):
            desc += f"\n{m['note']}"
        events.append({
            "id": uid,
            "title": m["name"],
            "start": f"{d.isoformat()}T{t_start}:00{SHANGHAI}",
            "end": f"{d.isoformat()}T{t_end}:00{SHANGHAI}",
            "location": m["room"],
            "description": desc,
        })

    by_slot: dict[tuple[int, int], list[dict]] = {}
    for m in meetings:
        for w in m["weeks"]:
            by_slot.setdefault((w, m["day_of_week"]), []).append(m)

    span_start, span_end = None, None
    for (w, dow), ms in by_slot.items():
        d = fwm + timedelta(weeks=w - 1, days=dow - 1)
        span_start, span_end = d if span_start is None or d < span_start else span_start, \
                               d if span_end is None or d > span_end else span_end
        if d in excluded:
            continue
        if d in overrides:
            continue  # handled in the override pass below
        for m in ms:
            emit(m, d)

    for d, ov in overrides.items():
        if ov.get("cancel"):
            continue
        src = ov.get("source_date")
        if not src:
            continue
        sw, sdow = source_week_day(fwm, date.fromisoformat(src))
        for m in by_slot.get((sw, sdow), []):
            mm = dict(m)
            if ov.get("location"):
                mm["room"] = ov["location"]
            if ov.get("note"):
                mm["note"] = ov["note"]
            emit(mm, d)
        if d in excluded:
            warn(f"{d} 既是调课日又是停课日，按停课处理未生成事件")

    if span_start and span_end:
        warn(f"展开范围 {span_start} ~ {span_end}（{len(events)} 个事件）")
    events.sort(key=lambda e: e["start"])
    return events


# ── HTTP fetch (urllib + storage_state cookies) ────────────────────────────
def load_cookies() -> str:
    p = session_path()
    if not p.is_file():
        die(f"没有登录会话 {p} —— 先跑 login（uv run --with playwright python3 scripts/xjtu-gmis.py login）", 3)
    state = json.loads(p.read_text("utf-8"))
    cookies = [c for c in state.get("cookies", []) if "xjtu.edu.cn" in c.get("domain", "")]
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies)


def fetch_page(url: str) -> str:
    req = urllib.request.Request(url, headers={
        "Cookie": load_cookies(),
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            final = res.geturl()
            body = res.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        die(f"无法连接 {GMIS_BASE}（{e.reason}）—— 校内系统，校外访问需要 WebVPN", 4)
    if "gmis.xjtu.edu.cn" not in final:
        die(f"会话已失效（被重定向到 {final}）—— 重新跑 login", 3)
    return body


def save_raw(term: str, html_text: str):
    p = raw_path(term)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(html_text, "utf-8")


def do_fetch(key: str) -> str:
    """GET the schedule page for the term matching `key`; cache and return HTML."""
    term = key_to_term(key)
    first = fetch_page(SCHEDULE_PAGE)
    options = parse_term_options(first)
    if term in options:
        # The plain GET already shows some term — only refetch when it isn't ours.
        if parse_selected_term(first) == term:
            save_raw(term, first)
            return first
        html_text = fetch_page(f"{SCHEDULE_PAGE}/{TERM_PARAM}/{options[term]}")
    else:
        warn(f"下拉框没有学期 {term!r}（可选：{', '.join(options) or '解析失败'}），用当前页继续")
        html_text = first
    save_raw(term, html_text)
    return html_text


def load_cached(key: str) -> str | None:
    p = raw_path(key_to_term(key))
    return p.read_text("utf-8") if p.is_file() else None


# ── Subcommands ────────────────────────────────────────────────────────────
def cmd_login(_args):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        die("login 需要 playwright：uv run --with playwright python3 scripts/xjtu-gmis.py login")

    session_path().parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(channel="chrome", headless=False)
        except Exception:
            try:
                browser = pw.chromium.launch(headless=False)
            except Exception as e:
                die(f"无法启动浏览器（{e}）—— 装 Chrome 或跑 uv run --with playwright playwright install chromium")
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        page.goto(SCHEDULE_PAGE)
        print("在弹出的浏览器里完成统一身份认证；课表页面出现后窗口会自动继续（最长等 10 分钟）。")
        deadline = datetime.now() + timedelta(minutes=10)
        ok = False
        while datetime.now() < deadline:
            try:
                if page.locator("select#drpxq").count() > 0 or "td_" in page.content():
                    ok = True
                    break
            except Exception:
                pass
            page.wait_for_timeout(2000)
        if not ok:
            browser.close()
            die("等到超时也没看到课表页面，会话未保存。")
        ctx.storage_state(path=str(session_path()))
        browser.close()
    print(f"会话已保存到 {session_path()}")


def cmd_fetch(args):
    html_text = do_fetch(semester_key(args))
    meetings = parse_schedule_html(html_text)
    print(f"fetched: {len(meetings)} 个课程安排")


def cmd_events(args):
    key = semester_key(args)
    html_text = Path(args.input).read_text("utf-8") if args.input else load_cached(key)
    if html_text is None:
        die(f"没有 {key} 的缓存课表，先跑 fetch 或 pull")
    meetings = parse_schedule_html(html_text)
    if not meetings:
        die("课表页解析出 0 个课程安排 —— 页面结构可能变了，或缓存是登录页/错误页")
    events = expand(meetings, load_semester_config(key, args.calendar_config),
                    load_schedule_config(args.schedule_config), key)
    print(json.dumps({"events": events}, ensure_ascii=False))


def cmd_pull(args):
    key = semester_key(args)
    try:
        html_text = do_fetch(key)
    except SystemExit as e:
        # fetch died (session/network) — fall back to the cached snapshot
        if e.code != 0 and load_cached(key) is not None:
            warn("fetch 失败，改用上次缓存的课表快照")
            html_text = load_cached(key)
        else:
            raise
    meetings = parse_schedule_html(html_text)
    if not meetings:
        die("课表页解析出 0 个课程安排")
    events = expand(meetings, load_semester_config(key, args.calendar_config),
                    load_schedule_config(args.schedule_config), key)
    print(json.dumps({"events": events}, ensure_ascii=False))


def cmd_doctor(args):
    key = semester_key(args)
    problems = []
    print(f"semester key : {key}（GMIS 学期名 {key_to_term(key)}）")
    p = session_path()
    if p.is_file():
        age_h = (datetime.now().timestamp() - p.stat().st_mtime) / 3600
        print(f"session      : {p}（{age_h:.0f} 小时前写入）")
    else:
        problems.append("没有登录会话，先跑 login")
    for label, fn in (("calendar cfg", lambda: load_semester_config(key, args.calendar_config)),
                      ("schedule cfg", lambda: load_schedule_config(args.schedule_config))):
        try:
            fn()
            print(f"{label:13}: ok")
        except SystemExit:
            problems.append(label)
    if load_cached(key) is None:
        problems.append("没有课表快照，先跑 fetch/pull")
    else:
        n = len(parse_schedule_html(load_cached(key)))
        print(f"cached html  : {n} 个课程安排")
        if n == 0:
            problems.append("缓存页解析为 0 个课程安排")
    if problems:
        for x in problems:
            warn(f"✗ {x}")
        sys.exit(5)
    print("all good")


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--semester", help="学期标识，如 2026-fall（默认按今天推导）")
    common.add_argument("--calendar-config", help="校历 JSON 覆盖路径")
    common.add_argument("--schedule-config", help="作息表 JSON 覆盖路径")
    ap = argparse.ArgumentParser(description="XJTU GMIS 研究生课表 → Pulse courses 事件",
                                 parents=[common])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login", parents=[common])
    sub.add_parser("fetch", parents=[common])
    pev = sub.add_parser("events", parents=[common])
    pev.add_argument("--input", help="从本地 HTML 文件解析（跳过缓存/网络）")
    sub.add_parser("pull", parents=[common])
    sub.add_parser("doctor", parents=[common])
    args = ap.parse_args()
    {"login": cmd_login, "fetch": cmd_fetch, "events": cmd_events,
     "pull": cmd_pull, "doctor": cmd_doctor}[args.cmd](args)


if __name__ == "__main__":
    main()
