# Copyright 2026 Kamal Singh Bisht
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""The Eventgen Manager built-in generation engine.

Reads eventgen.conf stanzas from every app, runs each enabled one on its own
thread, and sends what it generates through the stanza's output. There is no
dependency on SA-Eventgen and nothing platform-specific: it is the same
Python on Linux, macOS, and Windows, on x86 and ARM alike.

The engine re-reads its configuration every few seconds and restarts only
the configurations that changed, so turning one on or off, or editing it,
takes effect without restarting anything.

Token replacement is shared with the preview (eventgen_preview), so what the
preview shows is what the engine emits.
"""

from __future__ import absolute_import, division, print_function

import csv
import datetime
import hashlib
import io
import json
import os
import random
import re
import threading
import time

import eventgen_preview as core
import egm_outputs

ENGINE_VERSION = "2.0.0"

RESERVED_STANZAS = ("default", "global")
MAX_SAMPLE_BYTES = 64 * 1024 * 1024
MAX_EVENTS_PER_BATCH = 500000
MAX_BACKFILL_EVENTS = 5000000
METRICS_EVERY = 30.0
STATUS_EVERY = 5.0
REPLAY_SLICE = 0.25
ERROR_RETRY = 60.0


def _now_local():
    return datetime.datetime.now().astimezone()


def kv(**fields):
    """Format fields as key="value" pairs, which Splunk extracts unaided."""
    parts = []
    for key, value in fields.items():
        if value is None:
            continue
        if isinstance(value, float):
            value = "%.3f" % value
        text = str(value).replace("\\", "\\\\").replace('"', '\\"')
        text = text.replace("\n", " ").replace("\r", " ")
        parts.append('%s="%s"' % (key, text))
    return " ".join(parts)


# --------------------------------------------------------------------------
# Resolving stanzas into runnable configurations
# --------------------------------------------------------------------------


class Config(object):
    """One sample file to generate from, with the settings that apply."""

    def __init__(self, app, stanza, sample_name, settings, app_dir,
                 sample_dir, sample_path=None, error=None):
        self.app = app
        self.stanza = stanza
        self.sample_name = sample_name
        self.settings = settings
        self.app_dir = app_dir
        self.sample_dir = sample_dir
        self.sample_path = sample_path
        self.error = error

    @property
    def key(self):
        if self.sample_name and self.sample_name != self.stanza:
            return "%s/%s/%s" % (self.app, self.stanza, self.sample_name)
        return "%s/%s" % (self.app, self.stanza)

    @property
    def enabled(self):
        return not core._is_true(self.settings.get("disabled"))

    def search_dirs(self, fallback_dirs=()):
        dirs = [self.sample_dir, os.path.join(self.app_dir, "samples")]
        dirs.extend(fallback_dirs)
        unique = []
        for directory in dirs:
            if directory and directory not in unique:
                unique.append(directory)
        return unique

    def fingerprint(self):
        digest = hashlib.sha1()
        digest.update(json.dumps(self.settings, sort_keys=True)
                      .encode("utf-8"))
        digest.update((self.sample_path or "").encode("utf-8"))
        if self.sample_path:
            try:
                stat = os.stat(self.sample_path)
                digest.update(("%s:%s" % (stat.st_size, stat.st_mtime))
                              .encode("utf-8"))
            except OSError:
                digest.update(b"missing")
        digest.update((self.error or "").encode("utf-8"))
        return digest.hexdigest()


def _resolve_sample_dir(app_dir, setting, splunk_home):
    if not setting:
        return os.path.join(app_dir, "samples")
    path = str(setting).strip()
    if splunk_home:
        path = path.replace("$SPLUNK_HOME", splunk_home)
    path = os.path.expandvars(path)
    if os.path.isabs(path):
        return os.path.normpath(path)
    # Relative paths are resolved from the folder holding eventgen.conf.
    for base in (os.path.join(app_dir, "local"),
                 os.path.join(app_dir, "default"), app_dir):
        candidate = os.path.normpath(os.path.join(base, path))
        if os.path.isdir(candidate):
            return candidate
    return os.path.normpath(os.path.join(app_dir, "default", path))


def resolve_configs(entries, apps_root, splunk_home=None):
    """Turn (app, stanza, settings) entries into Config objects.

    Mirrors eventgen's own rules: a [global] stanza in an app supplies
    defaults for that app's stanzas, and a stanza name that is not a file is
    treated as a regular expression matched against the sample directory.
    """
    globals_by_app = {}
    for app, stanza, settings in entries:
        if stanza == "global":
            globals_by_app[app] = dict(settings)

    configs = []
    for app, stanza, settings in entries:
        if stanza in RESERVED_STANZAS:
            continue
        merged = dict(globals_by_app.get(app, {}))
        merged.update(settings)
        merged = {key: value for key, value in merged.items()
                  if not key.startswith("eai:")}

        app_dir = os.path.join(apps_root, app)
        sample_dir = _resolve_sample_dir(app_dir, merged.get("sampleDir"),
                                         splunk_home)
        exact = os.path.join(sample_dir, stanza)
        if os.path.isfile(exact):
            configs.append(Config(app, stanza, stanza, merged, app_dir,
                                  sample_dir, exact))
            continue

        matched = []
        try:
            pattern = re.compile(stanza)
            if os.path.isdir(sample_dir):
                for name in sorted(os.listdir(sample_dir)):
                    path = os.path.join(sample_dir, name)
                    if os.path.isfile(path) and pattern.fullmatch(name):
                        matched.append((name, path))
        except re.error:
            pass

        if not matched:
            configs.append(Config(
                app, stanza, stanza, merged, app_dir, sample_dir, None,
                error="Sample file %s was not found in %s."
                      % (stanza, sample_dir)))
            continue
        for name, path in matched:
            configs.append(Config(app, stanza, name, merged, app_dir,
                                  sample_dir, path))
    return configs


# --------------------------------------------------------------------------
# One configuration, generating
# --------------------------------------------------------------------------


def _parse_end(value, now):
    """Return (intervals, end_time); either may be None."""
    if value is None or str(value).strip() == "":
        return None, None
    text = str(value).strip()
    try:
        number = int(text)
        return (number if number > 0 else None), None
    except ValueError:
        pass
    return None, core.parse_relative_time(text, now)


def _replay_time_formats(spec):
    spec = str(spec or "").strip()
    if spec.startswith("["):
        try:
            formats = json.loads(spec)
            return [str(item) for item in formats if item]
        except ValueError:
            return []
    return [spec] if spec else []


def _parse_with_formats(text, formats):
    text = text.strip()
    for fmt in formats:
        candidates = [(text, fmt)]
        if "%e" in fmt:
            candidates.append((re.sub(r"\s+", " ", text),
                               fmt.replace("%e", "%d")))
        for value, form in candidates:
            if form == "%s":
                try:
                    return datetime.datetime.fromtimestamp(float(value))
                except ValueError:
                    continue
            try:
                parsed = datetime.datetime.strptime(value, form)
            except ValueError:
                continue
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone().replace(tzinfo=None)
            return parsed
    return None


class Runner(threading.Thread):
    """Generates events for one Config until stopped or finished."""

    def __init__(self, config, output_context, logger, counters=None,
                 fallback_dirs=()):
        threading.Thread.__init__(self, name="egm-" + config.key)
        self.daemon = True
        self.config = config
        self.settings = config.settings
        self.logger = logger
        self.output_context = output_context
        self.fallback_dirs = list(fallback_dirs)
        self.stop_event = threading.Event()
        self.fingerprint = config.fingerprint()
        self.output = None
        self.position = 0
        self.saved_counters = counters or {}
        self.stats = {
            "app": config.app,
            "stanza": config.stanza,
            "sample": config.sample_name,
            "outputMode": str(self.settings.get("outputMode") or "modinput"),
            "mode": str(self.settings.get("mode") or "sample"),
            "state": "starting",
            "events": 0,
            "bytes": 0,
            "batches": 0,
            "errors": 0,
            "lastBatchAt": None,
            "lastBatchEvents": 0,
            "lastError": None,
            "lastErrorAt": None,
            "nextRunAt": None,
            "startedAt": time.time(),
            "behind": 0,
        }
        self._metric = {"events": 0, "bytes": 0, "batches": 0, "errors": 0}

    # -- helpers -----------------------------------------------------------

    def log(self, level, event, **fields):
        getattr(self.logger, level)(kv(
            event=event, stanza=self.config.stanza, app=self.config.app,
            sample=self.config.sample_name, **fields))

    def counters(self):
        result = {}
        for replacer in getattr(self, "replacers", []):
            if replacer.replacement_type == "integerid":
                result[str(replacer.index)] = replacer.counter
        return result

    def take_metrics(self):
        snapshot = dict(self._metric)
        for key in self._metric:
            self._metric[key] = 0
        return snapshot

    def stop(self):
        self.stop_event.set()

    def _sleep_until(self, epoch):
        delay = epoch - time.time()
        if delay > 0:
            self.stop_event.wait(delay)
        return not self.stop_event.is_set()

    # -- setup -------------------------------------------------------------

    def _prepare(self):
        settings = self.settings
        if self.config.error:
            raise core.PreviewError(self.config.error)
        problems = core.engine_compatibility(settings)
        if problems:
            raise core.PreviewError(" ".join(problems))

        size = os.path.getsize(self.config.sample_path)
        if size > MAX_SAMPLE_BYTES:
            raise core.PreviewError(
                "The sample is %d MB. The built-in engine reads samples up "
                "to %d MB." % (size // 1048576, MAX_SAMPLE_BYTES // 1048576))
        with io.open(self.config.sample_path, "r", encoding="utf-8",
                     errors="replace") as handle:
            text = handle.read()

        self.metadata = []
        self.csv_rows = []
        if str(settings.get("sampletype", "raw")).strip().lower() == "csv":
            self.events, self.metadata = core.parse_csv_sample(text)
            self.csv_rows = [row for row in csv.DictReader(io.StringIO(text))
                             if row.get("_raw") is not None]
        else:
            self.events = core.split_events(text, settings)
        if not self.events:
            raise core.PreviewError("The sample %s holds no events."
                                    % self.config.sample_name)

        self.files = core.ReplacementFiles(
            self.config.search_dirs(self.fallback_dirs))
        self.replacers = []
        for definition in core.extract_tokens(settings):
            replacer = core.TokenReplacer(
                definition["index"], definition["token"],
                definition["replacementType"], definition["replacement"],
                self.files, 1.0)
            saved = self.saved_counters.get(str(definition["index"]))
            if saved is not None:
                replacer.counter = saved
            self.replacers.append(replacer)
        # Validate every replacement once up front, so a typo is reported
        # immediately rather than on the first event that reaches it.
        probe_time = _now_local()
        for replacer in self.replacers:
            if replacer.replacement_type not in ("integerid", "seqfile"):
                replacer.value(probe_time, {}, probe_time)
        if self.files.missing:
            raise core.PreviewError(
                "Replacement files not found: %s."
                % ", ".join(self.files.missing))

        self.host_setting = core.HostSetting(settings, self.files)
        self.autotimestamp = core._is_true(settings.get("autotimestamp"))
        self.autotimestamp_now = self.autotimestamp and \
            core.autotimestamp_uses_now(settings)
        self.tzinfo = core.resolve_timezone(settings.get("timezone"))
        self.interval = max(0, core._as_int(settings.get("interval"), 60))
        self.count = core._as_int(settings.get("count"), 0)
        self.randomize_count = core._as_float(
            settings.get("randomizeCount"), 0.0)
        self.randomize_events = core._is_true(settings.get("randomizeEvents"))
        self.per_day_volume = core._as_float(settings.get("perDayVolume"), 0.0)
        self.avg_size = max(1.0, sum(len(e) + 1 for e in self.events) /
                            float(len(self.events)))
        self.has_rates = any(settings.get(key) for key in (
            "hourOfDayRate", "dayOfWeekRate", "minuteOfHourRate",
            "dayOfMonthRate", "monthOfYearRate"))
        # Parse the curves once, so bad JSON surfaces now.
        core.compute_rating(settings, _now_local())

        self.defaults = {
            "index": settings.get("index") or None,
            "sourcetype": settings.get("sourcetype") or "eventgen",
            "source": settings.get("source") or self.config.sample_name,
            "host": settings.get("host") or None,
        }
        self.output = egm_outputs.create_output(
            settings, self.config.stanza, self.output_context)

    # -- event construction --------------------------------------------

    def _build(self, raw, event_time, replay_time, row_index):
        shared_rows = {}
        event = raw
        if self.autotimestamp:
            if self.autotimestamp_now:
                # Stamp the moment the event is built, ignoring earliest,
                # latest, and backfill, and index it at that same time so
                # _time matches the timestamp written into the event.
                event_time = datetime.datetime.now(tz=self.tzinfo)
            event, _ = core.auto_timestamp(event, event_time)
        for replacer in self.replacers:
            event, _ = replacer.apply_fast(event, event_time, shared_rows,
                                           replay_time)
        result = dict(self.defaults)
        if self.host_setting.active:
            event, host = self.host_setting.apply(event)
            if host:
                result["host"] = host
        if row_index is not None and row_index < len(self.metadata):
            result.update(self.metadata[row_index])
        result["raw"] = event
        result["time"] = event_time.timestamp()
        return result

    def _batch_size(self, when):
        if self.per_day_volume > 0:
            seconds = self.interval or 60
            target_bytes = self.per_day_volume * 1073741824.0 * \
                seconds / 86400.0
            size = int(round(target_bytes / self.avg_size))
        elif self.count > 0:
            size = self.count
        else:
            size = len(self.events)

        if self.has_rates:
            rating, _ = core.compute_rating(self.settings, when)
            size = int(round(size * rating))
            for replacer in self.replacers:
                replacer.rating = rating
        if self.randomize_count > 0:
            low = int(round(size * (1 - self.randomize_count)))
            high = int(round(size * (1 + self.randomize_count)))
            size = random.randint(max(0, low), max(0, high))
        return max(0, min(size, MAX_EVENTS_PER_BATCH))

    def generate_batch(self, now):
        """Build one interval's events as of ``now`` (an aware datetime)."""
        earliest = core.parse_relative_time(
            self.settings.get("earliest", "now"), now)
        latest = core.parse_relative_time(
            self.settings.get("latest", "now"), now)
        size = self._batch_size(now)
        batch = []
        total = len(self.events)
        for _ in range(size):
            if self.randomize_events:
                index = random.randrange(total)
            else:
                index = self.position % total
                self.position += 1
            event_time = core._random_between(earliest, latest)
            batch.append(self._build(self.events[index], event_time,
                                     event_time, index))
        return batch

    # -- sending -------------------------------------------------------

    def _send(self, batch):
        if not batch:
            return
        size = sum(len(event["raw"]) for event in batch)
        try:
            self.output.send(batch)
        except egm_outputs.OutputError as exc:
            self._error(str(exc))
            return
        self.stats["events"] += len(batch)
        self.stats["bytes"] += size
        self.stats["batches"] += 1
        self.stats["lastBatchAt"] = time.time()
        self.stats["lastBatchEvents"] = len(batch)
        self._metric["events"] += len(batch)
        self._metric["bytes"] += size
        self._metric["batches"] += 1

    def _error(self, message):
        self.stats["errors"] += 1
        self._metric["errors"] += 1
        self.stats["lastError"] = message
        self.stats["lastErrorAt"] = time.time()
        self.log("error", "batch_failed", msg=message)

    # -- modes ---------------------------------------------------------

    def _backfill(self):
        setting = self.settings.get("backfill")
        if not setting or self.interval <= 0:
            return
        now = datetime.datetime.now(tz=self.tzinfo)
        try:
            start = core.parse_relative_time(setting, now)
        except core.PreviewError as exc:
            self._error("backfill: %s" % exc)
            return
        if start >= now:
            return
        self.stats["state"] = "backfilling"
        self.log("info", "backfill_start", since=start.isoformat())
        produced = 0
        cursor = start
        step = datetime.timedelta(seconds=self.interval)
        while cursor < now and not self.stop_event.is_set():
            batch = self.generate_batch(cursor)
            self._send(batch)
            produced += len(batch)
            if produced >= MAX_BACKFILL_EVENTS:
                self.log("warning", "backfill_capped", events=produced)
                break
            cursor += step
        self.log("info", "backfill_done", events=produced)

    def _run_sample(self):
        now = datetime.datetime.now(tz=self.tzinfo)
        intervals, end_time = _parse_end(self.settings.get("end"), now)
        self._backfill()

        runs = 0
        next_run = time.time()
        while not self.stop_event.is_set():
            now = datetime.datetime.now(tz=self.tzinfo)
            if end_time is not None and now >= end_time:
                break
            self.stats["state"] = "running"
            try:
                self._send(self.generate_batch(now))
            except core.PreviewError as exc:
                self._error(str(exc))
            runs += 1
            if self.interval <= 0 or (intervals and runs >= intervals):
                break
            next_run += self.interval
            if next_run < time.time() - self.interval:
                # Generation or output is slower than the interval. Skip the
                # missed runs rather than bursting to catch up.
                self.stats["behind"] += 1
                self.log("warning", "behind_schedule",
                         interval=self.interval)
                next_run = time.time()
            self.stats["nextRunAt"] = next_run
            self.stats["state"] = "waiting"
            if not self._sleep_until(next_run):
                break

    def _original_times(self):
        """Original timestamps of each event, for replay pacing."""
        time_field = (self.settings.get("timeField") or "_raw").strip()
        formats = []
        regexes = []
        for replacer in self.replacers:
            if replacer.replacement_type == "replaytimestamp":
                regexes.append(replacer.regex)
                formats.append(_replay_time_formats(replacer.replacement))

        times = []
        for position, raw in enumerate(self.events):
            parsed = None
            if time_field != "_raw" and position < len(self.csv_rows):
                value = self.csv_rows[position].get(time_field)
                if value:
                    parsed = _parse_with_formats(value, [
                        "%s", "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z",
                        "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"])
            if parsed is None:
                for regex, fmts in zip(regexes, formats):
                    match = regex.search(raw)
                    if not match:
                        continue
                    text = match.group(1) if match.groups() else match.group(0)
                    parsed = _parse_with_formats(text, fmts)
                    if parsed is not None:
                        break
            times.append(parsed)
        return times

    def _run_replay(self):
        times = self._original_times()
        known = [value for value in times if value is not None]
        if not known:
            self.log("warning", "replay_no_timestamps",
                     msg="No replaytimestamp token matched a parseable time, "
                         "so each pass sends the whole sample at once.")
        multiple = core._as_float(self.settings.get("timeMultiple"), 1.0)
        if multiple <= 0:
            multiple = 1.0

        offsets = []
        previous = None
        elapsed = 0.0
        for value in times:
            if value is not None and previous is not None:
                gap = (value - previous).total_seconds()
                if gap > 0:
                    elapsed += gap * multiple
            if value is not None:
                previous = value
            offsets.append(elapsed)
        span = offsets[-1] if offsets else 0.0
        # Between passes, wait the interval if one is set; otherwise keep the
        # sample's own average spacing so the loop is seamless.
        explicit = str(self.settings.get("interval") or "").strip()
        if explicit and self.interval > 0:
            gap_between_passes = float(self.interval)
        else:
            gap_between_passes = max(1.0, span / max(1, len(offsets) - 1))

        now = datetime.datetime.now(tz=self.tzinfo)
        passes, end_time = _parse_end(self.settings.get("end"), now)
        done = 0
        while not self.stop_event.is_set():
            started = time.time()
            self.stats["state"] = "running"
            position = 0
            total = len(self.events)
            while position < total and not self.stop_event.is_set():
                due = started + offsets[position]
                if due > time.time():
                    self.stats["nextRunAt"] = due
                    self.stats["state"] = "waiting"
                    if not self._sleep_until(due):
                        return
                    self.stats["state"] = "running"
                horizon = time.time() + REPLAY_SLICE
                batch = []
                while position < total and started + offsets[position] <= \
                        horizon:
                    stamp = datetime.datetime.now(tz=self.tzinfo)
                    batch.append(self._build(self.events[position], stamp,
                                             stamp, position))
                    position += 1
                self._send(batch)
            done += 1
            if passes and done >= passes:
                return
            if end_time is not None and \
                    datetime.datetime.now(tz=self.tzinfo) >= end_time:
                return
            if not self._sleep_until(time.time() + gap_between_passes):
                return

    # -- thread --------------------------------------------------------

    def run(self):
        try:
            self._prepare()
        except (core.PreviewError, egm_outputs.OutputError, OSError,
                ValueError) as exc:
            self.stats["state"] = "error"
            self._error(str(exc))
            return

        delay = core._as_int(self.settings.get("delay"), 0)
        if delay > 0:
            self.stats["state"] = "waiting"
            self.stats["nextRunAt"] = time.time() + delay
            if not self._sleep_until(time.time() + delay):
                self._finish("stopped")
                return

        self.log("info", "started", mode=self.stats["mode"],
                 output=self.stats["outputMode"])
        try:
            if self.stats["mode"].strip().lower() == "replay":
                self._run_replay()
            else:
                self._run_sample()
        except Exception as exc:  # noqa: BLE001 - keep the engine alive
            self.stats["state"] = "error"
            self._error("Stopped unexpectedly: %s" % exc)
            self.logger.exception("runner crashed")
            self._close_output()
            return
        self._finish("stopped" if self.stop_event.is_set() else "finished")

    def _finish(self, state):
        self.stats["state"] = state
        self.stats["nextRunAt"] = None
        self._close_output()
        self.log("info", state, events=self.stats["events"])

    def _close_output(self):
        if self.output is not None:
            try:
                self.output.close()
            except Exception:  # noqa: BLE001
                pass


# --------------------------------------------------------------------------
# The engine
# --------------------------------------------------------------------------


class Engine(object):
    """Keeps one Runner per enabled configuration, reloading on change."""

    def __init__(self, source, logger, output_context, status_path=None,
                 reload_interval=10, fallback_dirs=(), only=None):
        self.source = source
        self.logger = logger
        self.output_context = output_context
        self.status_path = status_path
        self.reload_interval = max(2, int(reload_interval))
        self.fallback_dirs = list(fallback_dirs)
        self.only = only
        self.runners = {}
        self.inactive = {}
        self.stop_event = threading.Event()
        self.state = "starting"
        self.reason = None
        self.last_reload = None
        self.last_reload_error = None
        self.started = time.time()
        self.counters = self._load_counters()

    # -- persistence ---------------------------------------------------

    def _load_counters(self):
        if not self.status_path or not os.path.isfile(self.status_path):
            return {}
        try:
            with io.open(self.status_path, "r", encoding="utf-8") as handle:
                return json.load(handle).get("counters", {}) or {}
        except (IOError, OSError, ValueError):
            return {}

    def status(self):
        stanzas = {}
        for key, runner in self.runners.items():
            stats = dict(runner.stats)
            stats["enabled"] = True
            stanzas[key] = stats
            counters = runner.counters()
            if counters:
                self.counters[key] = counters
        for key, info in self.inactive.items():
            stanzas.setdefault(key, info)
        return {
            "engine": {
                "version": ENGINE_VERSION,
                "state": self.state,
                "reason": self.reason,
                "pid": os.getpid(),
                "startedAt": self.started,
                "updatedAt": time.time(),
                "lastReload": self.last_reload,
                "lastReloadError": self.last_reload_error,
                "reloadInterval": self.reload_interval,
                "running": sum(1 for r in self.runners.values()
                               if r.is_alive()),
            },
            "stanzas": stanzas,
            "counters": self.counters,
        }

    def write_status(self):
        if not self.status_path:
            return
        data = self.status()
        directory = os.path.dirname(self.status_path)
        temp = self.status_path + ".tmp"
        try:
            if directory and not os.path.isdir(directory):
                os.makedirs(directory)
            with io.open(temp, "w", encoding="utf-8") as handle:
                handle.write(json.dumps(data, default=str))
            os.replace(temp, self.status_path)
        except (IOError, OSError) as exc:
            self.logger.warning(kv(event="status_write_failed", msg=str(exc)))

    def log_metrics(self):
        for key, runner in self.runners.items():
            metric = runner.take_metrics()
            if not any(metric.values()) and runner.stats["state"] in (
                    "error", "finished", "stopped"):
                continue
            self.logger.info(kv(
                event="metrics", metric="throughput", key=key,
                stanza=runner.config.stanza, app=runner.config.app,
                sample=runner.config.sample_name,
                source=runner.defaults.get("source")
                if hasattr(runner, "defaults") else runner.config.sample_name,
                output=runner.stats["outputMode"], state=runner.stats["state"],
                period=METRICS_EVERY, **metric))

    # -- lifecycle -----------------------------------------------------

    def _stop_runner(self, key, wait=True):
        runner = self.runners.pop(key, None)
        if runner is None:
            return
        runner.stop()
        if wait:
            runner.join(10)
        counters = runner.counters()
        if counters:
            self.counters[key] = counters

    def stop_all(self):
        for key in list(self.runners):
            self.runners[key].stop()
        for key in list(self.runners):
            self._stop_runner(key)

    def reload(self):
        self.last_reload = time.time()
        try:
            if self.source.conflicting_generator_active():
                if self.state != "standby":
                    self.logger.warning(kv(
                        event="standby",
                        msg="SA-Eventgen's modular input is running. The "
                            "built-in engine waits so events are not "
                            "generated twice. Stop SA-Eventgen to switch."))
                self.state = "standby"
                self.reason = "sa-eventgen-active"
                self.stop_all()
                self.inactive = {}
                return
            entries = self.source.load()
        except Exception as exc:  # noqa: BLE001 - keep current runners
            self.last_reload_error = str(exc)
            self.logger.error(kv(event="reload_failed", msg=str(exc)))
            return

        if self.state != "running":
            self.logger.info(kv(event="engine_running",
                                version=ENGINE_VERSION))
        self.state = "running"
        self.reason = None
        self.last_reload_error = None

        configs = resolve_configs(entries, self.source.apps_root,
                                  self.source.splunk_home)
        if self.only:
            configs = [c for c in configs
                       if c.stanza in self.only or c.key in self.only]

        wanted = {}
        inactive = {}
        for config in configs:
            if config.enabled:
                wanted[config.key] = config
            else:
                inactive[config.key] = {
                    "app": config.app, "stanza": config.stanza,
                    "sample": config.sample_name, "state": "paused",
                    "enabled": False,
                    "outputMode": str(config.settings.get("outputMode") or
                                      "modinput"),
                }
        self.inactive = inactive

        for key in list(self.runners):
            config = wanted.get(key)
            if config is None or \
                    config.fingerprint() != self.runners[key].fingerprint:
                reason = "removed" if config is None else "changed"
                self.logger.info(kv(event="config_" + reason, key=key))
                self._stop_runner(key)

        for key, config in wanted.items():
            existing = self.runners.get(key)
            if existing is not None:
                # A configuration that failed is retried now and then, since
                # the cause (a file not yet uploaded, a receiver not yet up)
                # often fixes itself without any change to the settings.
                retry = existing.stats["state"] == "error" and \
                    time.time() - existing.stats["startedAt"] >= ERROR_RETRY
                if not retry:
                    continue
                self._stop_runner(key)
            runner = Runner(config, self.output_context, self.logger,
                            self.counters.get(key), self.fallback_dirs)
            self.runners[key] = runner
            runner.start()

    def run_forever(self, duration=None):
        deadline = time.time() + duration if duration else None
        next_reload = 0.0
        next_status = 0.0
        next_metrics = time.time() + METRICS_EVERY
        try:
            while not self.stop_event.is_set():
                now = time.time()
                if deadline and now >= deadline:
                    break
                if now >= next_reload:
                    self.reload()
                    next_reload = now + self.reload_interval
                if now >= next_metrics:
                    self.log_metrics()
                    next_metrics = now + METRICS_EVERY
                if now >= next_status:
                    self.write_status()
                    next_status = now + STATUS_EVERY
                if self.only and self.runners and not any(
                        r.is_alive() for r in self.runners.values()) and \
                        deadline is None:
                    break
                self.stop_event.wait(0.5)
        finally:
            self.state = "stopped"
            for runner in self.runners.values():
                runner.stop()
            for runner in self.runners.values():
                runner.join(10)
            self.log_metrics()
            self.write_status()

    def stop(self):
        self.stop_event.set()


# --------------------------------------------------------------------------
# Configuration sources
# --------------------------------------------------------------------------


class FileSource(object):
    """Reads eventgen.conf files directly. Used outside Splunk."""

    def __init__(self, paths, splunk_home=None):
        self.paths = [os.path.abspath(path) for path in paths]
        self.splunk_home = splunk_home
        # <apps root>/<app>/{default,local}/eventgen.conf
        first = self.paths[0] if self.paths else os.getcwd()
        self.apps_root = os.path.dirname(os.path.dirname(
            os.path.dirname(first)))

    def conflicting_generator_active(self):
        return False

    def load(self):
        merged = {}
        order = []
        for path in self.paths:
            app = os.path.basename(os.path.dirname(os.path.dirname(path)))
            for stanza, settings in read_conf(path):
                key = (app, stanza)
                if key not in merged:
                    merged[key] = {}
                    order.append(key)
                merged[key].update(settings)
        return [(app, stanza, merged[(app, stanza)])
                for app, stanza in order]


def read_conf(path):
    """Parse a Splunk .conf file into (stanza, settings) pairs.

    Handles comments, line continuations, and keys appearing before any
    stanza (which belong to [default]).
    """
    stanzas = []
    current = "default"
    settings = {}
    pending = ""
    with io.open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
        lines = handle.read().splitlines()
    for line in lines:
        if pending:
            line = pending + line
            pending = ""
        if line.endswith("\\") and not line.endswith("\\\\"):
            pending = line[:-1] + "\n"
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or \
                stripped.startswith(";"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            if settings or current != "default":
                stanzas.append((current, settings))
            current = stripped[1:-1]
            settings = {}
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            settings[key.strip()] = value.strip()
    stanzas.append((current, settings))
    return stanzas


class SplunkRestSource(object):
    """Reads eventgen.conf through splunkd, exactly as Splunk merges it."""

    CONF_PATH = "/servicesNS/nobody/-/configs/conf-eventgen"
    SA_EVENTGEN_PATH = "/servicesNS/nobody/-/data/inputs/modinput_eventgen"

    def __init__(self, session_key, apps_root, splunk_home, rest=None):
        self.session_key = session_key
        self.apps_root = apps_root
        self.splunk_home = splunk_home
        if rest is None:
            import splunk.rest as rest  # noqa: F811 - only inside Splunk
        self.rest = rest

    def _get(self, path):
        """Return (status, parsed JSON or None)."""
        try:
            response, content = self.rest.simpleRequest(
                path, sessionKey=self.session_key, method="GET",
                getargs={"output_mode": "json", "count": "0"})
        except Exception as exc:  # noqa: BLE001 - splunk raises on 404
            status = getattr(exc, "statusCode", None) or \
                getattr(exc, "status", None)
            if status is None and type(exc).__name__ == "ResourceNotFound":
                status = 404
            return status, None
        status = getattr(response, "status", None)
        if status not in (200, 201):
            return status, None
        try:
            if isinstance(content, bytes):
                content = content.decode("utf-8", "replace")
            return status, json.loads(content)
        except ValueError:
            return status, None

    def conflicting_generator_active(self):
        status, data = self._get(self.SA_EVENTGEN_PATH)
        if not data:
            return False
        for entry in data.get("entry", []):
            disabled = (entry.get("content") or {}).get("disabled", True)
            if not core._is_true(disabled):
                return True
        return False

    def load(self):
        status, data = self._get(self.CONF_PATH)
        if data is None:
            if status == 404:
                return []  # no eventgen.conf anywhere yet
            raise RuntimeError("splunkd returned %s for %s"
                               % (status, self.CONF_PATH))
        entries = []
        for entry in data.get("entry", []):
            acl = entry.get("acl") or {}
            content = {}
            for key, value in (entry.get("content") or {}).items():
                if key.startswith("eai:") or value is None:
                    continue
                if isinstance(value, bool):
                    value = "true" if value else "false"
                content[key] = str(value)
            entries.append((acl.get("app") or "eventgen_manager",
                            entry.get("name"), content))
        return entries
