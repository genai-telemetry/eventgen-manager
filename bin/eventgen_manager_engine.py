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
"""Modular input that runs the Eventgen Manager built-in engine.

Inside Splunk, splunkd launches this once (single-instance mode) and reads
generated events from its standard output.

Outside Splunk, it runs the same engine against eventgen.conf files:

    python eventgen_manager_engine.py run --conf default/eventgen.conf \\
        --include-disabled --duration 30

Events whose outputMode is modinput are printed to standard output in that
mode; every other output works exactly as it does inside Splunk.
"""

from __future__ import absolute_import, division, print_function

import argparse
import logging
import logging.handlers
import os
import signal
import sys
import xml.dom.minidom

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import egm_engine  # noqa: E402
import egm_outputs  # noqa: E402

SCHEME_NAME = "eventgen_manager_engine"
LOG_FILE = "eventgen_manager_engine.log"

SCHEME = """<scheme>
    <title>Eventgen Manager engine</title>
    <description>Generates events from eventgen.conf configurations in every app. Built into Eventgen Manager; SA-Eventgen is not needed.</description>
    <use_external_validation>true</use_external_validation>
    <use_single_instance>true</use_single_instance>
    <streaming_mode>xml</streaming_mode>
    <endpoint>
        <args>
            <arg name="log_level">
                <title>Log level</title>
                <description>DEBUG, INFO, WARNING, or ERROR. Written to eventgen_manager_engine.log.</description>
                <required_on_create>false</required_on_create>
                <required_on_edit>false</required_on_edit>
            </arg>
            <arg name="reload_interval">
                <title>Reload interval</title>
                <description>Seconds between checks for configuration changes. Changes apply within this time.</description>
                <data_type>number</data_type>
                <required_on_create>false</required_on_create>
                <required_on_edit>false</required_on_edit>
            </arg>
        </args>
    </endpoint>
</scheme>
"""

LEVELS = {"DEBUG": logging.DEBUG, "INFO": logging.INFO,
          "WARNING": logging.WARNING, "WARN": logging.WARNING,
          "ERROR": logging.ERROR}


def splunk_home():
    return os.environ.get("SPLUNK_HOME") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))


def make_logger(level="INFO", path=None, stream=None):
    logger = logging.getLogger("eventgen_manager_engine")
    logger.handlers = []
    logger.propagate = False
    logger.setLevel(LEVELS.get(str(level).upper(), logging.INFO))
    if path:
        directory = os.path.dirname(path)
        if directory and not os.path.isdir(directory):
            os.makedirs(directory)
        handler = logging.handlers.RotatingFileHandler(
            path, maxBytes=25 * 1024 * 1024, backupCount=5)
    else:
        handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s level=%(levelname)s pid=%(process)d %(message)s"))
    logger.addHandler(handler)
    return logger


def validate_arguments(text):
    """Reject impossible values before splunkd saves them."""
    doc = xml.dom.minidom.parseString(text)
    params = {}
    for node in doc.getElementsByTagName("param"):
        params[node.getAttribute("name")] = "".join(
            child.data for child in node.childNodes
            if child.nodeType == child.TEXT_NODE).strip()
    level = params.get("log_level")
    if level and level.upper() not in LEVELS:
        return "log_level must be DEBUG, INFO, WARNING, or ERROR."
    interval = params.get("reload_interval")
    if interval:
        try:
            if int(interval) < 2:
                return "reload_interval must be at least 2 seconds."
        except ValueError:
            return "reload_interval must be a whole number of seconds."
    return None


def parse_config(text):
    """Read what splunkd passes on standard input."""
    doc = xml.dom.minidom.parseString(text)
    root = doc.documentElement

    def text_of(tag):
        nodes = root.getElementsByTagName(tag)
        if not nodes or not nodes[0].firstChild:
            return ""
        return nodes[0].firstChild.data.strip()

    stanzas = []
    for node in root.getElementsByTagName("stanza"):
        params = {}
        for param in node.getElementsByTagName("param"):
            params[param.getAttribute("name")] = "".join(
                child.data for child in param.childNodes
                if child.nodeType == child.TEXT_NODE).strip()
        stanzas.append((node.getAttribute("name"), params))

    return {
        "server_uri": text_of("server_uri"),
        "session_key": text_of("session_key"),
        "checkpoint_dir": text_of("checkpoint_dir"),
        "stanzas": stanzas,
    }


def run_modinput(stdin, stdout, rest=None):
    config = parse_config(stdin.read())
    home = splunk_home()
    stanza_name, params = (config["stanzas"] or
                           [(SCHEME_NAME + "://default", {})])[0]

    logger = make_logger(
        params.get("log_level", "INFO"),
        os.path.join(home, "var", "log", "splunk", LOG_FILE))
    if len(config["stanzas"]) > 1:
        logger.warning(egm_engine.kv(
            event="extra_inputs",
            msg="Only one engine runs per instance; using %s." % stanza_name))

    checkpoint = config["checkpoint_dir"] or os.path.join(
        home, "var", "lib", "splunk", "modinputs", SCHEME_NAME)
    writer = egm_outputs.ModinputWriter(stdout, stanza_name)
    writer.open()

    source = egm_engine.SplunkRestSource(
        config["session_key"], os.path.join(home, "etc", "apps"), home,
        rest=rest)
    engine = egm_engine.Engine(
        source, logger,
        {"writer": writer, "logger": logger, "splunk_home": home,
         "stdout": stdout},
        status_path=os.path.join(checkpoint, "status.json"),
        reload_interval=int(params.get("reload_interval") or 10),
        fallback_dirs=[os.path.join(home, "etc", "apps", "eventgen_manager",
                                    "samples")])

    def shutdown(signum, frame):  # noqa: ARG001
        engine.stop()

    for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), shutdown)
            except (ValueError, OSError):
                pass

    logger.info(egm_engine.kv(event="engine_start",
                              version=egm_engine.ENGINE_VERSION,
                              input=stanza_name, python=sys.version.split()[0],
                              platform=sys.platform))
    try:
        engine.run_forever()
    finally:
        writer.close()
        logger.info(egm_engine.kv(event="engine_stop"))


def run_cli(argv):
    parser = argparse.ArgumentParser(
        prog="eventgen_manager_engine.py run",
        description="Run the Eventgen Manager engine without Splunk.")
    parser.add_argument("--conf", action="append", required=True,
                        help="An eventgen.conf file. Repeat for several; "
                             "later files override earlier ones.")
    parser.add_argument("--stanza", action="append",
                        help="Run only this stanza. Repeatable.")
    parser.add_argument("--include-disabled", action="store_true",
                        help="Run stanzas even if they are turned off.")
    parser.add_argument("--duration", type=float,
                        help="Stop after this many seconds.")
    parser.add_argument("--status", help="Write engine status JSON here.")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logger = make_logger(args.log_level, stream=sys.stderr)
    source = egm_engine.FileSource(args.conf, splunk_home())
    if args.include_disabled:
        original = source.load

        def load_all():
            entries = original()
            for _, _, settings in entries:
                settings["disabled"] = "false"
            return entries
        source.load = load_all

    engine = egm_engine.Engine(
        source, logger,
        {"writer": None, "logger": logger, "splunk_home": splunk_home(),
         "stdout": sys.stdout},
        status_path=args.status, reload_interval=5, only=args.stanza)
    try:
        engine.run_forever(duration=args.duration)
    except KeyboardInterrupt:
        engine.stop()
    return 0


def main(argv):
    if len(argv) > 1 and argv[1] == "--scheme":
        sys.stdout.write(SCHEME)
        return 0
    if len(argv) > 1 and argv[1] == "--validate-arguments":
        error = validate_arguments(sys.stdin.read())
        if error:
            sys.stdout.write("<error><message>%s</message></error>" % error)
            return 1
        return 0
    if len(argv) > 1 and argv[1] == "run":
        return run_cli(argv[2:])
    run_modinput(sys.stdin, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
