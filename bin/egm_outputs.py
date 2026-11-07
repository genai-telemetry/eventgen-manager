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
"""Where the built-in engine sends events.

Each output takes a list of event dicts and delivers them. An event carries:

    raw         the event text
    time        epoch seconds (float)
    index, sourcetype, source, host   metadata, any of which may be None

Outputs raise OutputError when delivery fails; the engine counts the failure
against the configuration and carries on with the next batch.
"""

from __future__ import absolute_import, division, print_function

import base64
import datetime
import io
import json
import os
import re
import socket
import ssl
import threading
import time

try:  # Python 3
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError, URLError
    from urllib.parse import urlencode
except ImportError:  # pragma: no cover - Splunk ships Python 3 only
    raise

NETWORK_TIMEOUT = 15
DEFAULT_HEC_PAYLOAD = 512 * 1024
DEFAULT_FILE_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_FILE_BACKUPS = 5

# Characters XML 1.0 cannot carry, even escaped.
_XML_INVALID = re.compile(u"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")


class OutputError(Exception):
    """Delivery failed; the message is shown to the user as-is."""


def _is_true(value, default=False):
    if value is None or str(value).strip() == "":
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _as_int(value, default):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _expand(path, splunk_home):
    path = str(path or "").strip()
    if splunk_home:
        path = path.replace("$SPLUNK_HOME", splunk_home)
    return os.path.expanduser(os.path.expandvars(path))


def _ssl_context(verify):
    context = ssl.create_default_context()
    if not verify:
        # Opt-in only, through verifySSL = false on the stanza. Splunk's own
        # HEC and management ports ship with a self-signed certificate, so
        # local testing needs this; anything else should leave it on.
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def _xml_escape(text):
    text = _XML_INVALID.sub("", text)
    return (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


# --------------------------------------------------------------------------
# Splunk modular input stream
# --------------------------------------------------------------------------


class ModinputWriter(object):
    """Writes the XML event stream splunkd reads from a modular input.

    One writer is shared by every configuration, so writes are serialised.
    """

    def __init__(self, stream, stanza_name):
        self.stream = stream
        self.stanza = _xml_escape(stanza_name or "")
        self.lock = threading.Lock()
        self.opened = False
        self.broken = False

    def _write(self, text):
        self.stream.write(text)
        self.stream.flush()

    def open(self):
        with self.lock:
            if not self.opened:
                self._write("<stream>\n")
                self.opened = True

    def close(self):
        with self.lock:
            if self.opened and not self.broken:
                try:
                    self._write("</stream>\n")
                except (IOError, OSError, ValueError):
                    pass
            self.opened = False

    def write_events(self, events):
        parts = []
        for event in events:
            parts.append('<event stanza="%s">' % self.stanza)
            parts.append("<time>%.3f</time>" % event["time"])
            for key in ("index", "sourcetype", "source", "host"):
                value = event.get(key)
                if value:
                    parts.append("<%s>%s</%s>" % (key, _xml_escape(value), key))
            # <done/> closes the event for splunkd's aggregator. Without it,
            # a sourcetype that keeps the default SHOULD_LINEMERGE = true
            # glues consecutive events together, so far fewer events reach
            # the index than the engine sent.
            parts.append("<data>%s</data><done/></event>\n"
                         % _xml_escape(event["raw"]))
        text = "".join(parts)
        with self.lock:
            if not self.opened:
                self._write("<stream>\n")
                self.opened = True
            try:
                self._write(text)
            except (IOError, OSError, ValueError) as exc:
                self.broken = True
                raise OutputError("splunkd stopped reading events: %s" % exc)


# --------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------


class Output(object):
    name = "base"

    def send(self, events):
        raise NotImplementedError

    def close(self):
        pass


class ModinputOutput(Output):
    name = "modinput"

    def __init__(self, writer):
        self.writer = writer

    def send(self, events):
        self.writer.write_events(events)


class StdoutOutput(Output):
    """Prints raw events. Only used when the engine runs outside Splunk."""

    name = "stdout"

    def __init__(self, stream):
        self.stream = stream
        self.lock = threading.Lock()

    def send(self, events):
        text = "".join(event["raw"] + "\n" for event in events)
        with self.lock:
            self.stream.write(text)
            self.stream.flush()


class LogOutput(Output):
    """stdout inside Splunk: stdout is the event stream, so log instead."""

    name = "stdout"

    def __init__(self, logger, stanza):
        self.logger = logger
        self.stanza = stanza

    def send(self, events):
        for event in events:
            self.logger.info('event=stdout_output stanza="%s" raw="%s"',
                             self.stanza, event["raw"].replace('"', '\\"'))


class DevnullOutput(Output):
    name = "devnull"

    def send(self, events):
        return None


class FileOutput(Output):
    """Appends to a file, rolling it like a log once it grows too large."""

    name = "file"

    def __init__(self, settings, splunk_home):
        path = settings.get("fileName")
        if not path:
            raise OutputError("outputMode is file but fileName is empty.")
        self.path = _expand(path, splunk_home)
        if not os.path.isabs(self.path):
            raise OutputError("fileName must be a full path, such as "
                              "$SPLUNK_HOME/var/log/eventgen/web.log.")
        self.max_bytes = max(1024, _as_int(settings.get("fileMaxBytes"),
                                           DEFAULT_FILE_MAX_BYTES))
        self.backups = max(0, _as_int(settings.get("fileBackupFiles"),
                                      DEFAULT_FILE_BACKUPS))
        self.lock = threading.Lock()

    def _roll(self):
        if self.backups == 0:
            os.remove(self.path)
            return
        for number in range(self.backups - 1, 0, -1):
            older = "%s.%d" % (self.path, number)
            if os.path.exists(older):
                os.replace(older, "%s.%d" % (self.path, number + 1))
        os.replace(self.path, self.path + ".1")

    def send(self, events):
        data = "".join(event["raw"] + "\n" for event in events)
        with self.lock:
            try:
                directory = os.path.dirname(self.path)
                if directory and not os.path.isdir(directory):
                    os.makedirs(directory)
                if os.path.exists(self.path) and \
                        os.path.getsize(self.path) >= self.max_bytes:
                    self._roll()
                with io.open(self.path, "a", encoding="utf-8",
                             newline="\n") as handle:
                    handle.write(data)
            except (IOError, OSError) as exc:
                raise OutputError("Could not write %s: %s" % (self.path, exc))


class SpoolOutput(Output):
    """Drops each batch into a spool directory for Splunk to pick up."""

    name = "spool"

    def __init__(self, settings, splunk_home, stanza):
        directory = settings.get("spoolDir") or \
            os.path.join(splunk_home or "", "var", "spool", "splunk")
        self.directory = _expand(directory, splunk_home)
        base = settings.get("spoolFile") or stanza
        self.base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
        self.sequence = 0

    def send(self, events):
        self.sequence += 1
        name = "%s-%d-%d" % (self.base, int(time.time() * 1000), self.sequence)
        temp = os.path.join(self.directory, "." + name + ".tmp")
        final = os.path.join(self.directory, name)
        try:
            if not os.path.isdir(self.directory):
                os.makedirs(self.directory)
            with io.open(temp, "w", encoding="utf-8", newline="\n") as handle:
                handle.write("".join(event["raw"] + "\n" for event in events))
            # Renamed into place whole, so Splunk never reads half a batch.
            os.replace(temp, final)
        except (IOError, OSError) as exc:
            raise OutputError("Could not write to %s: %s"
                              % (self.directory, exc))


def _post(url, body, headers, verify):
    request = Request(url, data=body, headers=headers, method="POST")
    try:
        response = urlopen(request, timeout=NETWORK_TIMEOUT,
                           context=_ssl_context(verify))
        response.read()
        return response.status
    except HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        raise OutputError("%s answered %s %s" % (url, exc.code, detail))
    except (URLError, socket.timeout, ssl.SSLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        message = "Could not reach %s: %s" % (url, reason)
        if "CERTIFICATE_VERIFY_FAILED" in str(reason):
            message += (". The certificate is not trusted. For Splunk's "
                        "default self-signed certificate, set verifySSL = "
                        "false.")
        raise OutputError(message)


class HttpEventOutput(Output):
    """Sends to one or more HTTP Event Collector endpoints."""

    name = "httpevent"

    def __init__(self, settings):
        raw = settings.get("httpeventServers")
        if not raw:
            raise OutputError("outputMode is httpevent but httpeventServers "
                              "is empty.")
        try:
            parsed = json.loads(raw)
        except ValueError:
            raise OutputError("httpeventServers is not valid JSON.")
        servers = parsed.get("servers") if isinstance(parsed, dict) else parsed
        if not isinstance(servers, list) or not servers:
            raise OutputError('httpeventServers needs a "servers" list.')

        self.urls = []
        for server in servers:
            if not isinstance(server, dict) or not server.get("key") or \
                    not server.get("address"):
                raise OutputError("Each HEC server needs an address and a "
                                  "key.")
            self.urls.append((
                "%s://%s:%s/services/collector/event" % (
                    server.get("protocol", "https"), server["address"],
                    server.get("port", "8088")),
                server["key"]))

        self.mirror = str(settings.get("httpeventOutputMode", "roundrobin")) \
            .strip().lower() == "mirror"
        self.max_payload = max(1024, _as_int(
            settings.get("httpeventMaxPayloadSize"), DEFAULT_HEC_PAYLOAD))
        self.verify = _is_true(settings.get("verifySSL"), default=True)
        self.next = 0

    @staticmethod
    def _payload(event):
        body = {"time": round(event["time"], 3), "event": event["raw"]}
        for key in ("index", "sourcetype", "source", "host"):
            if event.get(key):
                body[key] = event[key]
        return json.dumps(body, separators=(",", ":"))

    def _chunks(self, events):
        chunk, size = [], 0
        for event in events:
            line = self._payload(event)
            if chunk and size + len(line) > self.max_payload:
                yield "".join(chunk)
                chunk, size = [], 0
            chunk.append(line)
            size += len(line)
        if chunk:
            yield "".join(chunk)

    def send(self, events):
        for chunk in self._chunks(events):
            body = chunk.encode("utf-8")
            if self.mirror:
                targets = self.urls
            else:
                targets = [self.urls[self.next % len(self.urls)]]
                self.next += 1
            for url, key in targets:
                _post(url, body, {"Authorization": "Splunk " + key,
                                  "Content-Type": "application/json"},
                      self.verify)


class SplunkStreamOutput(Output):
    """Posts to receivers/simple on a Splunk management port."""

    name = "splunkstream"

    def __init__(self, settings):
        host = settings.get("splunkHost")
        if not host:
            raise OutputError("outputMode is splunkstream but splunkHost is "
                              "empty.")
        host = str(host).strip()
        if host.startswith("["):
            try:
                self.hosts = [str(item) for item in json.loads(host)]
            except ValueError:
                raise OutputError("splunkHost looks like a list but is not "
                                  "valid JSON.")
        else:
            self.hosts = [host]
        self.port = str(settings.get("splunkPort") or "8089").strip()
        self.method = str(settings.get("splunkMethod") or "https").strip()
        user = settings.get("splunkUser") or ""
        password = settings.get("splunkPass") or ""
        if not user:
            raise OutputError("splunkstream needs splunkUser and splunkPass.")
        token = base64.b64encode(
            ("%s:%s" % (user, password)).encode("utf-8")).decode("ascii")
        self.auth = "Basic " + token
        self.verify = _is_true(settings.get("verifySSL"), default=True)
        self.next = 0

    def send(self, events):
        groups = {}
        for event in events:
            key = tuple(event.get(name) or "" for name in
                        ("index", "sourcetype", "source", "host"))
            groups.setdefault(key, []).append(event["raw"])
        for (index, sourcetype, source, host), raws in groups.items():
            params = {name: value for name, value in
                      (("index", index), ("sourcetype", sourcetype),
                       ("source", source), ("host", host)) if value}
            target = self.hosts[self.next % len(self.hosts)]
            self.next += 1
            url = "%s://%s:%s/services/receivers/simple?%s" % (
                self.method, target, self.port, urlencode(params))
            _post(url, "\n".join(raws).encode("utf-8"),
                  {"Authorization": self.auth}, self.verify)


class TcpOutput(Output):
    name = "tcpout"

    def __init__(self, settings):
        self.host = settings.get("tcpDestinationHost") or "127.0.0.1"
        self.port = _as_int(settings.get("tcpDestinationPort"), 3333)
        self.sock = None
        self.lock = threading.Lock()

    def _connect(self):
        self.sock = socket.create_connection((self.host, self.port),
                                             timeout=NETWORK_TIMEOUT)

    def send(self, events):
        data = "".join(event["raw"] + "\n" for event in events) \
            .encode("utf-8")
        with self.lock:
            for attempt in (1, 2):
                try:
                    if self.sock is None:
                        self._connect()
                    self.sock.sendall(data)
                    return
                except (OSError, socket.timeout) as exc:
                    self.close()
                    if attempt == 2:
                        raise OutputError("TCP %s:%s failed: %s"
                                          % (self.host, self.port, exc))

    def close(self):
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None


class SyslogOutput(TcpOutput):
    """Syslog over TCP, one message per line (RFC 6587 newline framing).

    Syslog over UDP is not offered: Splunk Cloud and Splunkbase app
    certification prohibit apps from sending UDP. Most receivers, Splunk TCP
    inputs included, accept newline-framed TCP syslog.
    """

    name = "syslogout"

    def __init__(self, settings):
        TcpOutput.__init__(self, settings)
        self.host = settings.get("syslogDestinationHost") or "127.0.0.1"
        self.port = _as_int(settings.get("syslogDestinationPort"), 1514)
        self.header = _is_true(settings.get("syslogAddHeader"))
        self.default_host = settings.get("host") or socket.gethostname()

    def _line(self, event):
        raw = event["raw"].replace("\r", " ").replace("\n", " ")
        if not self.header:
            return raw
        when = datetime.datetime.fromtimestamp(event["time"])
        stamp = when.strftime("%b ") + ("%2d" % when.day) + \
            when.strftime(" %H:%M:%S")
        return "<13>%s %s %s" % (stamp, event.get("host") or self.default_host,
                                 raw)

    def send(self, events):
        TcpOutput.send(self, [{"raw": self._line(event)} for event in events])


# --------------------------------------------------------------------------
# Factory
# --------------------------------------------------------------------------


def create_output(settings, stanza, context):
    """Build the output a stanza asks for.

    ``context`` supplies what depends on how the engine is running:
    ``writer`` (a ModinputWriter, or None outside Splunk), ``stdout``,
    ``logger``, and ``splunk_home``.
    """
    mode = str(settings.get("outputMode") or "modinput").strip().lower()
    writer = context.get("writer")

    if mode == "modinput":
        if writer is not None:
            return ModinputOutput(writer)
        return StdoutOutput(context["stdout"])
    if mode == "stdout":
        if writer is not None:
            return LogOutput(context["logger"], stanza)
        return StdoutOutput(context["stdout"])
    if mode == "devnull":
        return DevnullOutput()
    if mode == "file":
        return FileOutput(settings, context.get("splunk_home"))
    if mode == "spool":
        return SpoolOutput(settings, context.get("splunk_home"), stanza)
    if mode == "httpevent":
        return HttpEventOutput(settings)
    if mode == "splunkstream":
        return SplunkStreamOutput(settings)
    if mode == "tcpout":
        return TcpOutput(settings)
    if mode == "udpout":
        raise OutputError("outputMode udpout is not supported: Splunk Cloud "
                          "and app certification do not allow apps to send "
                          "UDP. Use tcpout, or syslogout, which sends over "
                          "TCP.")
    if mode == "syslogout":
        return SyslogOutput(settings)
    raise OutputError("outputMode %s is not supported by the built-in "
                      "engine." % mode)
