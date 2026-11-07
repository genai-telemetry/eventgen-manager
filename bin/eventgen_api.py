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
"""REST API for the Eventgen Manager UI.

Registered at /services/eventgen_manager/api by default/restmap.conf.

Routes
------
GET    /health                     engine status and install checks
GET    /status                     live per-configuration engine status
GET    /apps                       apps that can hold eventgen stanzas
GET    /samples?app=               sample files available to an app
GET    /sample?app=&name=&lines=   contents of one sample file
POST   /sample                     create or overwrite a sample file
DELETE /sample?app=&name=          remove a sample file
POST   /preview                    render events for a draft stanza
POST   /testbatch                  generate a few events for real, now

Stanza CRUD deliberately lives on Splunk's own configs/conf-eventgen
endpoint rather than here, so that permissions, replication, and conf-layer
precedence keep working the way administrators already expect.
"""

from __future__ import absolute_import, division, print_function

import datetime
import json
import os
import re
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from splunk.persistconn.application import PersistentServerConnectionApplication  # noqa: E402
from splunk.clilib.bundle_paths import make_splunkhome_path  # noqa: E402

import splunk.rest  # noqa: E402

import eventgen_preview  # noqa: E402
import egm_engine  # noqa: E402
import egm_outputs  # noqa: E402

APP_NAME = "eventgen_manager"
EVENTGEN_APP = "SA-Eventgen"
ENGINE_SCHEME = "eventgen_manager_engine"
# The engine rewrites its status file every few seconds while it runs. A
# file older than this means the engine is not running, whatever the input
# setting says.
STATUS_STALE_AFTER = 30
MAX_TEST_EVENTS = 1000

# Apps that must never be written to: upgrades overwrite them, so anything
# stored there would be silently lost.
PROTECTED_APPS = frozenset([
    "SA-Eventgen", "system", "search", "splunk_instrumentation",
    "splunk_monitoring_console", "splunk_secure_gateway",
    "splunk_archiver", "splunk_httpinput", "learned", "user-prefs",
    "framework", "launcher", "gettingstarted", "legacy", "alert_logevent",
    "alert_webhook", "introspection_generator_addon", "journald_input",
    "python_upgrade_readiness_app", "sample_app", "appsbrowser",
    "splunk_gdi", "splunk_rapid_diag", "splunk_internal_metrics",
])

# Conservative: no directory separators, no leading dot, no shell characters.
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\- ]{0,127}$")

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_READ_LINES = 500
SAMPLE_EXTENSIONS = (".sample", ".csv", ".log", ".txt", ".json", ".list",
                     ".tsv", ".xml", ".dat", "")


def _null_logger():
    import logging
    logger = logging.getLogger("eventgen_manager_api.testbatch")
    if not logger.handlers:
        logger.addHandler(logging.NullHandler())
    logger.propagate = False
    return logger


class ApiError(Exception):
    """An error with a message suitable for showing directly to the user."""

    def __init__(self, message, status=400):
        Exception.__init__(self, message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------------
# Path helpers
# --------------------------------------------------------------------------


def status_path():
    """Where the engine writes its status: its modular input checkpoint."""
    return make_splunkhome_path(["var", "lib", "splunk", "modinputs",
                                 ENGINE_SCHEME, "status.json"])


def read_status():
    """The engine's last status report, with its age in seconds."""
    path = status_path()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    engine = data.get("engine") or {}
    updated = engine.get("updatedAt") or 0
    data["age"] = max(0, int(time.time() - updated)) if updated else None
    data["fresh"] = bool(updated) and data["age"] <= STATUS_STALE_AFTER \
        and engine.get("state") != "stopped"
    data.pop("counters", None)
    return data


def apps_root():
    return make_splunkhome_path(["etc", "apps"])


def app_dir(app):
    """Return the validated directory for an app, guarding against traversal."""
    if not app:
        app = APP_NAME
    if not SAFE_NAME.match(app):
        raise ApiError("'%s' is not a valid app name." % app)

    root = os.path.realpath(apps_root())
    candidate = os.path.realpath(os.path.join(root, app))

    if candidate != root and not candidate.startswith(root + os.sep):
        raise ApiError("'%s' is outside the apps directory." % app)
    if not os.path.isdir(candidate):
        raise ApiError("The app '%s' is not installed." % app, status=404)
    return candidate


def samples_dir(app):
    """Resolve <app>/samples, which is where eventgen looks by default."""
    return os.path.join(app_dir(app), "samples")


def safe_sample_path(app, name):
    """Resolve a sample file inside an app, rejecting anything that escapes."""
    if not name:
        raise ApiError("A file name is required.")
    if not SAFE_NAME.match(name):
        raise ApiError(
            "'%s' is not a valid file name. Use letters, numbers, spaces, "
            "dots, dashes, and underscores." % name)
    if ".." in name or "/" in name or "\\" in name:
        raise ApiError("File names cannot contain path separators.")

    directory = os.path.realpath(samples_dir(app))
    target = os.path.realpath(os.path.join(directory, name))
    if target != directory and not target.startswith(directory + os.sep):
        raise ApiError("'%s' is outside the samples directory." % name)
    return target


def writable_app(app):
    if app in PROTECTED_APPS:
        raise ApiError(
            "%s ships with Splunk or with eventgen, and an upgrade would "
            "erase anything stored there. Save to %s instead."
            % (app, APP_NAME), status=403)
    return app


# --------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------


class EventgenManagerApi(PersistentServerConnectionApplication):
    """Routes API requests for the Eventgen Manager pages."""

    def __init__(self, command_line=None, command_arg=None):
        PersistentServerConnectionApplication.__init__(self)

    # -- plumbing ----------------------------------------------------------

    def handle(self, in_string):
        try:
            request = json.loads(in_string)
        except ValueError:
            return self._reply({"error": "The request was not valid JSON."}, 400)

        try:
            method = (request.get("method") or "GET").upper()
            path = self._route(request)
            query = self._pairs(request.get("query"))
            session_key = (request.get("session") or {}).get("authtoken", "")
            payload = self._payload(request)

            handler = self._resolve(method, path)
            body = handler(query=query, payload=payload,
                           session_key=session_key)
            return self._reply(body, 200)

        except ApiError as exc:
            return self._reply({"error": exc.message}, exc.status)
        except (eventgen_preview.PreviewError,
                egm_outputs.OutputError) as exc:
            return self._reply({"error": str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001 - surface, don't swallow
            sys.stderr.write(
                "eventgen_manager: unhandled error: %s\n%s\n"
                % (exc, traceback.format_exc()))
            return self._reply(
                {"error": "The request failed: %s" % exc}, 500)

    def _resolve(self, method, path):
        routes = {
            ("GET", "health"): self.get_health,
            ("GET", "apps"): self.get_apps,
            ("GET", "samples"): self.get_samples,
            ("GET", "sample"): self.get_sample,
            ("POST", "sample"): self.post_sample,
            ("DELETE", "sample"): self.delete_sample,
            ("POST", "preview"): self.post_preview,
            ("GET", "status"): self.get_status,
            ("POST", "testbatch"): self.post_testbatch,
        }
        handler = routes.get((method, path))
        if handler is None:
            raise ApiError(
                "%s /%s is not an endpoint of this API." % (method, path),
                status=404)
        return handler

    @staticmethod
    def _route(request):
        path = request.get("path_info") or ""
        # Strip the registered prefix if splunkd passed the full path.
        path = re.sub(r"^/?(services/)?eventgen_manager/api/?", "", path)
        return path.strip("/").split("/")[0] if path.strip("/") else "health"

    @staticmethod
    def _pairs(raw):
        result = {}
        for item in raw or []:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                result[item[0]] = item[1]
        return result

    @staticmethod
    def _payload(request):
        raw = request.get("payload")
        if not raw:
            return {}
        if isinstance(raw, dict):
            return raw
        try:
            parsed = json.loads(raw)
        except ValueError:
            raise ApiError("The request body was not valid JSON.")
        if not isinstance(parsed, dict):
            raise ApiError("The request body must be a JSON object.")
        return parsed

    @staticmethod
    def _reply(body, status):
        return {
            "status": status,
            "payload": json.dumps(body),
            "headers": {"Content-Type": "application/json"},
        }

    # -- routes ------------------------------------------------------------

    def get_health(self, query=None, payload=None, session_key=None):
        """Report whether everything needed to generate events is in place."""
        engine_input = self._read_engine_input(session_key)
        sa_eventgen = self._read_sa_eventgen(session_key)
        status = read_status()
        engine = (status or {}).get("engine") or {}

        checks = []

        # 1. The input that runs the engine.
        if engine_input.get("available"):
            enabled = engine_input.get("enabled")
            detail = ("Turned on." if enabled else
                      "Turned off, so nothing is generated. Start it on "
                      "Generator control.")
        elif engine_input.get("reason") == "forbidden":
            enabled = False
            detail = ("Your role cannot read the engine input. The admin or "
                      "sc_admin role is needed.")
        else:
            enabled = False
            detail = ("The [%s://default] input is missing. Reinstall the "
                      "app or restart Splunk." % ENGINE_SCHEME)
        checks.append({"id": "engine_enabled",
                       "label": "The built-in engine is turned on",
                       "ok": bool(enabled), "detail": detail})

        # 2. Whether it is actually running, which only its status shows.
        running = bool(status and status.get("fresh") and
                       engine.get("state") == "running")
        if running:
            detail = ("Running %d configuration%s. Changes apply within %ss."
                      % (engine.get("running", 0),
                         "" if engine.get("running") == 1 else "s",
                         engine.get("reloadInterval", 10)))
        elif status and status.get("fresh") and \
                engine.get("state") == "standby":
            detail = ("On standby because SA-Eventgen is generating from the "
                      "same configurations. Switch to the built-in engine on "
                      "Generator control so events are not doubled.")
        elif not enabled:
            detail = "Not running, because the engine is turned off."
        elif status is None:
            detail = ("No report from the engine yet. It starts within a "
                      "minute of being turned on; if it does not, look in "
                      "eventgen_manager_engine.log.")
        elif engine.get("state") == "stopped":
            detail = ("The engine stopped %ss ago and has not started "
                      "again. Splunk restarts it within a minute; if it does "
                      "not, look in eventgen_manager_engine.log."
                      % status.get("age"))
        else:
            detail = ("The engine last reported %ss ago, so it is not "
                      "running. Look in eventgen_manager_engine.log, or turn "
                      "it off and on again." % status.get("age"))
        checks.append({"id": "engine_running",
                       "label": "The engine is generating",
                       "ok": running, "detail": detail})

        directory = samples_dir(APP_NAME)
        writable = os.access(directory, os.W_OK) if os.path.isdir(directory) \
            else os.access(app_dir(APP_NAME), os.W_OK)
        checks.append({
            "id": "samples_writable",
            "label": "Sample files can be saved",
            "ok": bool(writable),
            "detail": directory if writable else
                      ("Splunk cannot write to %s. Check the directory "
                       "permissions." % directory),
        })

        stanza_count, enabled_count = self._count_stanzas(session_key)
        checks.append({
            "id": "stanzas",
            "label": "Configurations exist",
            "ok": stanza_count > 0,
            "detail": ("%d configured, %d turned on."
                       % (stanza_count, enabled_count)) if stanza_count
                      else "No configurations yet. Create one to get started.",
        })

        failing = []
        if status and status.get("fresh"):
            failing = sorted(
                "%s (%s)" % (info.get("stanza"), info.get("app"))
                for info in (status.get("stanzas") or {}).values()
                if info.get("state") == "error")
        checks.append({
            "id": "config_errors",
            "label": "Every running configuration is healthy",
            "ok": not failing,
            "detail": ("Failing: %s. The Configurations page shows why."
                       % ", ".join(failing)) if failing else
                      "No configuration is reporting an error.",
        })

        return {
            "ok": all(check["ok"] for check in checks),
            "checks": checks,
            "engine": {
                "input": engine_input,
                "state": engine.get("state") if status and
                status.get("fresh") else ("stopped" if not enabled
                                          else "unknown"),
                "version": engine.get("version"),
                "pid": engine.get("pid"),
                "startedAt": engine.get("startedAt"),
                "reloadInterval": engine.get("reloadInterval"),
                "lastReloadError": engine.get("lastReloadError"),
                "reportAge": (status or {}).get("age"),
            },
            "saEventgen": sa_eventgen,
            "samplesDir": directory,
            "app": APP_NAME,
            "platform": sys.platform,
        }

    def get_status(self, query=None, payload=None, session_key=None):
        """Live per-configuration counters from the engine."""
        status = read_status()
        if status is None:
            return {"available": False, "engine": {}, "stanzas": {}}
        status["available"] = True
        return status

    def post_testbatch(self, query=None, payload=None, session_key=None):
        """Generate a handful of events now and deliver them.

        Uses the stanza's own output, so a test of an HEC, file, or syslog
        configuration exercises the real destination. Configurations that
        write through the modular input are indexed through splunkd's
        receivers endpoint instead, since only the engine owns that stream.
        """
        payload = payload or {}
        stanza = payload.get("stanza") or {}
        if not isinstance(stanza, dict):
            raise ApiError("'stanza' must be an object of settings.")
        app = payload.get("app") or APP_NAME
        name = payload.get("sample") or payload.get("name")
        if not name:
            raise ApiError("Choose the sample file to generate from.")
        try:
            count = int(payload.get("count", 10))
        except (TypeError, ValueError):
            raise ApiError("count must be a whole number.")
        if count < 1 or count > MAX_TEST_EVENTS:
            raise ApiError("A test batch holds between 1 and %d events."
                           % MAX_TEST_EVENTS)

        settings = {str(key): str(value) for key, value in stanza.items()
                    if value is not None}
        settings["count"] = str(count)
        settings.pop("perDayVolume", None)
        settings["randomizeCount"] = "0"
        for curve in ("hourOfDayRate", "dayOfWeekRate", "minuteOfHourRate",
                      "dayOfMonthRate", "monthOfYearRate"):
            settings.pop(curve, None)

        configs = egm_engine.resolve_configs(
            [(app, name, settings)], apps_root(),
            make_splunkhome_path([]))
        config = configs[0]
        if config.error:
            raise ApiError(config.error, status=404)

        output_mode = str(settings.get("outputMode") or "modinput").lower()
        direct = output_mode == "modinput"
        prepared = dict(settings)
        if direct:
            prepared["outputMode"] = "devnull"
        config.settings = prepared

        logger = _null_logger()
        runner = egm_engine.Runner(
            config, {"writer": None, "logger": logger,
                     "splunk_home": make_splunkhome_path([]),
                     "stdout": None},
            logger, fallback_dirs=[samples_dir(APP_NAME)])
        runner._prepare()
        if output_mode == "stdout":
            raise ApiError("stdout output has nowhere to show a test batch. "
                           "Use the preview instead.")

        now = datetime.datetime.now(tz=runner.tzinfo)
        if str(settings.get("mode", "sample")).lower() == "replay":
            batch = []
            for index in range(min(count, len(runner.events))):
                batch.append(runner._build(runner.events[index], now, now,
                                           index))
        else:
            batch = runner.generate_batch(now)

        try:
            if direct:
                indexed = self._index_directly(session_key, batch)
                destination = "index %s" % ", ".join(indexed)
            else:
                runner.output.send(batch)
                destination = output_mode
        finally:
            runner._close_output()

        return {
            "sent": len(batch),
            "destination": destination,
            "outputMode": output_mode,
            "sample": [event["raw"] for event in batch[:3]],
            "search": ("search index=%s sourcetype=%s earliest=-15m"
                       % (batch[0].get("index") or "main",
                          batch[0].get("sourcetype") or "eventgen"))
            if batch and direct else None,
        }

    def get_apps(self, query=None, payload=None, session_key=None):
        """List apps that can hold eventgen stanzas, manager app first."""
        root = apps_root()
        found = []

        try:
            entries = sorted(os.listdir(root))
        except OSError:
            entries = []

        for name in entries:
            path = os.path.join(root, name)
            if not os.path.isdir(path) or name.startswith("."):
                continue

            has_conf = any(os.path.isfile(os.path.join(path, layer,
                                                       "eventgen.conf"))
                           for layer in ("local", "default"))
            has_samples = os.path.isdir(os.path.join(path, "samples"))

            if name != APP_NAME and not (has_conf or has_samples):
                continue

            protected = name in PROTECTED_APPS
            found.append({
                "name": name,
                "label": self._app_label(path, name),
                "hasConf": has_conf,
                "hasSamples": has_samples,
                "writable": (not protected) and os.access(path, os.W_OK),
                "protected": protected,
                "isDefault": name == APP_NAME,
            })

        found.sort(key=lambda item: (not item["isDefault"],
                                     item["name"].lower()))
        return {"apps": found, "defaultApp": APP_NAME}

    def get_samples(self, query=None, payload=None, session_key=None):
        """List the sample files an app exposes to eventgen."""
        app = (query or {}).get("app") or APP_NAME
        directory = samples_dir(app)

        files = []
        if os.path.isdir(directory):
            for name in sorted(os.listdir(directory)):
                path = os.path.join(directory, name)
                if not os.path.isfile(path) or name.startswith("."):
                    continue
                try:
                    stat = os.stat(path)
                    line_count = self._count_lines(path)
                except OSError:
                    continue
                files.append({
                    "name": name,
                    "bytes": stat.st_size,
                    "modified": int(stat.st_mtime),
                    "lines": line_count,
                    "editable": os.access(path, os.W_OK),
                })

        return {
            "app": app,
            "dir": directory,
            "exists": os.path.isdir(directory),
            "files": files,
        }

    def get_sample(self, query=None, payload=None, session_key=None):
        """Return the first N lines of a sample file."""
        query = query or {}
        app = query.get("app") or APP_NAME
        path = safe_sample_path(app, query.get("name"))

        if not os.path.isfile(path):
            raise ApiError("'%s' was not found in %s."
                           % (query.get("name"), app), status=404)

        try:
            limit = int(query.get("lines", 200))
        except ValueError:
            limit = 200
        limit = max(1, min(limit, MAX_READ_LINES))

        lines, truncated, total = [], False, 0
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for number, line in enumerate(handle):
                    total = number + 1
                    if number < limit:
                        lines.append(line.rstrip("\n").rstrip("\r"))
                    else:
                        truncated = True
                        break
        except OSError as exc:
            raise ApiError("Could not read '%s': %s" % (query.get("name"), exc))

        return {
            "app": app,
            "name": query.get("name"),
            "content": "\n".join(lines),
            "lines": len(lines),
            "totalLines": total,
            "truncated": truncated,
            "path": path,
        }

    def post_sample(self, query=None, payload=None, session_key=None):
        """Create or overwrite a sample file."""
        payload = payload or {}
        app = writable_app(payload.get("app") or APP_NAME)
        name = payload.get("name")
        content = payload.get("content")

        if content is None:
            raise ApiError("The file content is missing.")
        if isinstance(content, bytes):
            content = content.decode("utf-8", "replace")
        if len(content.encode("utf-8", "ignore")) > MAX_UPLOAD_BYTES:
            raise ApiError(
                "The file is larger than %d MB. Trim the sample or place it "
                "on the server directly."
                % (MAX_UPLOAD_BYTES // (1024 * 1024)))

        path = safe_sample_path(app, name)
        directory = os.path.dirname(path)

        if os.path.isfile(path) and not payload.get("overwrite"):
            raise ApiError(
                "'%s' already exists in %s. Choose another name or replace it."
                % (name, app), status=409)

        try:
            if not os.path.isdir(directory):
                os.makedirs(directory)
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(content)
        except OSError as exc:
            raise ApiError("Could not save '%s': %s" % (name, exc), status=500)

        return {
            "saved": True,
            "app": app,
            "name": name,
            "path": path,
            "bytes": len(content.encode("utf-8", "ignore")),
            "lines": len(content.splitlines()),
        }

    def delete_sample(self, query=None, payload=None, session_key=None):
        """Remove a sample file."""
        query = query or {}
        app = writable_app(query.get("app") or APP_NAME)
        name = query.get("name")
        path = safe_sample_path(app, name)

        if not os.path.isfile(path):
            raise ApiError("'%s' was not found in %s." % (name, app),
                           status=404)
        try:
            os.remove(path)
        except OSError as exc:
            raise ApiError("Could not delete '%s': %s" % (name, exc),
                           status=500)

        return {"deleted": True, "app": app, "name": name}

    def post_preview(self, query=None, payload=None, session_key=None):
        """Render the events a draft stanza would produce."""
        payload = payload or {}
        stanza = payload.get("stanza") or {}
        if not isinstance(stanza, dict):
            raise ApiError("'stanza' must be an object of settings.")

        app = payload.get("app") or APP_NAME
        content = payload.get("content")

        if content is None:
            name = payload.get("sample")
            if not name:
                raise ApiError(
                    "Choose a sample file, or paste sample text to preview.")
            fetched = self.get_sample(
                query={"app": app, "name": name, "lines": MAX_READ_LINES})
            content = fetched["content"]

        directories = [samples_dir(app)]
        if app != APP_NAME:
            directories.append(samples_dir(APP_NAME))

        sample_dir_setting = stanza.get("sampleDir")
        if sample_dir_setting:
            resolved = self._resolve_sample_dir(app, sample_dir_setting)
            if resolved:
                directories.insert(0, resolved)

        result = eventgen_preview.render(
            stanza,
            content,
            search_dirs=directories,
            limit=payload.get("limit", 20),
            seed=payload.get("seed"),
        )
        result["app"] = app
        return result

    # -- internals ---------------------------------------------------------

    @staticmethod
    def _resolve_sample_dir(app, setting):
        """Resolve the sampleDir setting relative to the conf file location."""
        setting = str(setting).strip()
        if not setting:
            return None
        if os.path.isabs(setting):
            return setting if os.path.isdir(setting) else None
        # Relative paths are resolved from the directory holding the conf file.
        base = os.path.join(app_dir(app), "local")
        candidate = os.path.realpath(os.path.join(base, setting))
        return candidate if os.path.isdir(candidate) else None

    @staticmethod
    def _count_lines(path, cap=200000):
        count = 0
        try:
            with open(path, "rb") as handle:
                for count, _ in enumerate(handle, 1):
                    if count >= cap:
                        break
        except OSError:
            return 0
        return count

    @staticmethod
    def _app_label(path, fallback):
        for layer in ("local", "default"):
            conf = os.path.join(path, layer, "app.conf")
            if not os.path.isfile(conf):
                continue
            try:
                with open(conf, "r", encoding="utf-8",
                          errors="replace") as handle:
                    in_ui = False
                    for line in handle:
                        stripped = line.strip()
                        if stripped.startswith("["):
                            in_ui = stripped == "[ui]"
                        elif in_ui and stripped.startswith("label"):
                            return stripped.split("=", 1)[1].strip()
            except OSError:
                continue
        return fallback

    @classmethod
    def _splunkd(cls, session_key, path, method="GET", **kwargs):
        """Call splunkd on the user's behalf, returning parsed JSON."""
        return cls._splunkd_ex(session_key, path, method, **kwargs)[1]

    @staticmethod
    def _splunkd_ex(session_key, path, method="GET", **kwargs):
        """As _splunkd, but also returns the outcome.

        Callers that need to explain a failure to the user cannot do so if
        every problem arrives as None. The first element is the HTTP status,
        or a string describing why no request was made.
        """
        if not session_key:
            return "no-session", None
        try:
            response, content = splunk.rest.simpleRequest(
                path, sessionKey=session_key, method=method,
                getargs={"output_mode": "json", "count": "0"}, **kwargs)
        except Exception as exc:  # noqa: BLE001 - endpoint may not exist
            # Splunk raises for a missing endpoint rather than returning 404,
            # and the status hides on the exception. Recovering it is what
            # lets the caller say "not registered" instead of "unreachable".
            status = getattr(exc, "statusCode", None) or \
                getattr(exc, "status", None)
            return (status if isinstance(status, int) else "unreachable"), None
        status = getattr(response, "status", None)
        if status not in (200, 201):
            return status, None
        try:
            return status, json.loads(content)
        except ValueError:
            return status, None

    def _read_engine_input(self, session_key):
        """Read the built-in engine's input stanza."""
        status, data = self._splunkd_ex(
            session_key,
            "/servicesNS/nobody/%s/data/inputs/%s" % (APP_NAME, ENGINE_SCHEME))
        if data is None:
            reason = {404: "unregistered", 401: "forbidden",
                      403: "forbidden"}.get(status, "unreachable")
            return {"available": False, "reason": reason, "status": status}
        entries = data.get("entry", [])
        chosen = next((e for e in entries if e.get("name") == "default"),
                      entries[0] if entries else None)
        if chosen is None:
            return {"available": False, "reason": "no-input", "status": status}
        content = chosen.get("content", {})
        return {
            "available": True,
            "name": chosen.get("name"),
            "enabled": not eventgen_preview._is_true(
                content.get("disabled", False)),
            "logLevel": content.get("log_level") or "INFO",
            "reloadInterval": content.get("reload_interval") or "10",
        }

    def _read_sa_eventgen(self, session_key):
        """Whether SA-Eventgen is installed and generating.

        It is no longer needed, but if it is still running it generates from
        the same eventgen.conf, so the UI offers to switch it off.
        """
        installed = os.path.isdir(os.path.join(apps_root(), EVENTGEN_APP))
        info = {"installed": installed, "registered": False,
                "enabled": False, "inputs": []}
        if not installed:
            return info
        status, data = self._splunkd_ex(
            session_key,
            "/servicesNS/nobody/%s/data/inputs/modinput_eventgen"
            % EVENTGEN_APP)
        if data is None:
            return info
        info["registered"] = True
        for entry in data.get("entry", []):
            disabled = eventgen_preview._is_true(
                (entry.get("content") or {}).get("disabled", True))
            info["inputs"].append({"name": entry.get("name"),
                                   "enabled": not disabled})
            if not disabled:
                info["enabled"] = True
        return info

    def _index_directly(self, session_key, batch):
        """Index events through receivers/simple, one request per event.

        Posting several events joined by newlines lets Splunk merge them
        whenever the sourcetype keeps SHOULD_LINEMERGE = true, so fewer
        events would be indexed than the test sent. One event per request
        keeps every event separate whatever the sourcetype's settings.
        """
        if not session_key:
            raise ApiError("No session is available to index with.", 401)
        indexes = []
        for event in batch:
            index, sourcetype, source, host = (
                event.get(name) or "" for name in
                ("index", "sourcetype", "source", "host"))
            args = {name: value for name, value in
                    (("index", index), ("sourcetype", sourcetype),
                     ("source", source), ("host", host)) if value}
            try:
                response, content = splunk.rest.simpleRequest(
                    "/services/receivers/simple", sessionKey=session_key,
                    method="POST", getargs=args, jsonargs=event["raw"])
            except Exception as exc:  # noqa: BLE001
                raise ApiError("Splunk would not index the test batch: %s"
                               % exc, status=502)
            if getattr(response, "status", 200) not in (200, 201):
                raise ApiError("Splunk would not index the test batch "
                               "(status %s). Check that the index exists "
                               "and your role can write to it."
                               % getattr(response, "status", "?"), 502)
            if (index or "main") not in indexes:
                indexes.append(index or "main")
        return indexes

    def _count_stanzas(self, session_key):
        """Count eventgen stanzas across all apps."""
        data = self._splunkd(session_key, "/servicesNS/-/-/configs/conf-eventgen")
        if not data:
            return 0, 0

        total, enabled = 0, 0
        for entry in data.get("entry", []):
            name = entry.get("name", "")
            if name in ("default", "global"):
                continue
            total += 1
            content = entry.get("content", {})
            if str(content.get("disabled", "false")).lower() in ("0", "false"):
                enabled += 1
        return total, enabled
