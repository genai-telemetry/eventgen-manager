# Eventgen Manager

Configure, preview, and generate realistic test data in Splunk from the
browser, with no hand-editing of `eventgen.conf` and nothing else to install.

Generated data is the standard way to fill Splunk for demos, testing,
detection development, and load work. The `eventgen.conf` format that
describes it is powerful and entirely file-based: a stanza per sample file,
regular-expression tokens, JSON rate curves, and a dozen output modes. This
app puts a guided editor in front of all of it, shows you the events a
configuration will produce before a single one reaches an index, and, since
2.0, generates them itself with a built-in engine.

---

## What it gives you

**A built-in generation engine.** Eventgen Manager runs `eventgen.conf`
configurations itself. The engine is plain Python,
so it runs wherever Splunk does: Linux, macOS, and Windows, on x86 and ARM.

**Changes apply in seconds.** The engine checks for changed configurations
every ten seconds and restarts only the ones that changed. Starting,
pausing, or editing a configuration needs no restart of anything.

**A guided editor for every setting.** Interval, count, rate curves, output
mode, tokens. Fields appear only when they apply, so choosing HTTP Event
Collector shows collector endpoints and hides the spool directory. Every
field is labelled with the setting it writes, so what you learn here
transfers straight to `eventgen.conf`.

**A live preview.** As you edit, the preview pane renders the events your
configuration would generate, with every substituted value highlighted. The
preview and the engine share the same code, so what you see is what you get.

**Test events on demand.** One button in the editor generates a few events
for real and sends them to the configuration's destination, without turning
the configuration on. A wrong index, a bad HEC token, or a blocked port shows
up immediately.

**Live status for every configuration.** The Configurations page shows each
one's state, how many events it has produced, when its last batch went out,
and the reason if it is failing.

**Rate curves you can see.** Hour-of-day and day-of-week rates are edited as
values per bucket rather than as a wall of JSON.

**Sample file management.** Upload, write, review, and delete the sample
files that configurations generate from, without shell access to the server.

**Throughput monitoring.** Events per second, projected volume per day,
failed batches, and configured against measured rates, all from the engine's
own metrics, plus a check of what actually reached an index.

---

## Requirements

- Splunk Enterprise 9.0 or later, or Splunk Cloud
- The `admin` or `sc_admin` role to create or change configurations. Users
  with `list_inputs` can view them.

That is all. SA-Eventgen is no longer required. See "Coming from
SA-Eventgen" below if you have it installed.

---

## Installing

1. Install this app, either from Splunkbase or by extracting the package into
   `$SPLUNK_HOME/etc/apps/`.
2. Restart Splunk.
3. Open **Eventgen Manager** from the app menu.

The engine input ships turned on. Every starter configuration ships turned
off, so nothing is generated until you start one.

---

## Quick start

Four starter configurations ship with the app (web access logs, Linux
authentication logs, structured application logs, and firewall traffic),
along with the sample files they generate from.

1. Go to **Configurations**, pick a starter, and press **Clone**. Working on
   a clone means an app upgrade cannot overwrite your changes.
2. In the editor, watch the preview pane while you change the interval, the
   count, or a token. Adjust until the events look like what you need.
3. Press **Send test events** under the preview to put a few real events in
   the index, then follow the search link to check them.
4. Tick **Generate events with this configuration** and save. The engine
   picks it up within ten seconds.
5. Watch the **Generated** column on the Configurations page, or open
   **Throughput**.

For a complete, step-by-step guide with screenshots, open **Tutorial** in
the app's top bar, or read the
[Eventgen Manager tutorial](https://github.com/genai-telemetry/eventgen-manager/blob/main/Eventgen_Manager_Tutorial.pdf)
on GitHub.

---

## The built-in engine

The engine is a modular input, `eventgen_manager_engine://default`, that
splunkd starts once and keeps running. It:

- reads `eventgen.conf` from every app through splunkd, so conf-layer
  precedence and permissions behave as usual, and configurations that other
  apps ship run as well;
- runs each enabled configuration on its own thread, so one slow output
  never holds up another;
- re-reads configuration every `reload_interval` seconds (10 by default) and
  restarts only what changed, and also notices when a sample file changes;
- retries a failing configuration every minute, since causes like a receiver
  that is down often fix themselves;
- remembers counter (`integerid`) values across restarts, so identifiers
  never repeat;
- writes its log, including a throughput line per configuration every 30
  seconds, to `eventgen_manager_engine.log` in `_internal`.

As a guide, one configuration generates roughly 25,000 to 55,000 events a
second on a single core, depending on how many tokens it has.

### What it supports

| Area | Supported |
| --- | --- |
| Modes | `sample`, `replay` (paced by `replaytimestamp` tokens, or a CSV `timeField`) |
| Volume | `count`, `perDayVolume`, `randomizeCount`, `randomizeEvents`, all five rate curves, `backfill`, `delay`, `end` |
| Samples | raw with any `breaker`, `bundlelines`, CSV with per-event host, source, sourcetype, and index |
| Stanza names | file names, or regular expressions matching several sample files; `[global]` defaults per app |
| Tokens | `static`, `timestamp`, `replaytimestamp`, `random`, `rated`, `file`, `mvfile`, `seqfile`, `integerid`; `host.token`, `hostRegex`, `autotimestamp`, `autotimestampTime` |
| Outputs | `modinput`, `httpevent`, `splunkstream`, `file`, `spool`, `tcpout`, `syslogout` (over TCP), `stdout`, `devnull` |

### Extensions

These go beyond what SA-Eventgen understands. A configuration that uses them
runs only on the built-in engine.

- Random values `ipv4private`, `email`, and `useragent`, and `uuid` as
  another name for `guid`.
- `weighted{"200": 90, "404": 8, "500": 2}`, which picks values in proportion
  to their weights instead of repeating entries in a `list`.
- `verifySSL = false`, for HEC or splunkstream receivers using Splunk's
  default self-signed certificate. Verification is on unless you turn it off.

### What it does not do

- **`s2s` output.** Use `httpevent` or `splunkstream` to reach another
  Splunk instance.
- **UDP.** Splunk Cloud and Splunkbase app certification do not allow apps
  to send UDP, so `udpout` is not available and `syslogout` sends over TCP,
  one message per line. syslog-ng, rsyslog, and Splunk TCP inputs all accept
  that.
- **Custom generator and rater plugins, and Jinja templates.** These load
  SA-Eventgen's own Python modules. A configuration naming one is shown as
  failing, with the reason, rather than quietly run differently.
- **Worker and queue tuning.** `generatorWorkers`, `outputWorkers`,
  `threading`, and similar settings are accepted and ignored, because the
  engine sizes itself. `backfillSearch` is likewise ignored.

### Running it outside Splunk

The engine also runs from the command line, which is handy for checking a
configuration or producing a file of test data on a laptop:

    python bin/eventgen_manager_engine.py run \
        --conf default/eventgen.conf --include-disabled --duration 30

Configurations whose output is `modinput` print to standard output in this
mode. Every other output works as it does inside Splunk. Use `--stanza` to
run only some configurations.

---

## Coming from SA-Eventgen

Your configurations need no changes. The engine reads the same
`eventgen.conf`, in the same apps, with the same settings.

If SA-Eventgen's modular input is still running when you upgrade, the
built-in engine waits on standby rather than generate every event twice.
**Generator control** shows this, and its **Switch to the built-in engine**
button turns SA-Eventgen's input off. The engine takes over within seconds.
After that, SA-Eventgen can be uninstalled whenever nothing else on the
instance depends on it.

Three behaviours differ:

- `rated` works. SA-Eventgen 8.2.1 rejected it and inserted nothing.
- In sample mode, each interval continues through the sample file where the
  last one stopped, rather than starting from the top each time. Over a few
  intervals every line gets used.
- `syslogout` sends over TCP rather than UDP, and `udpout` is not available.
  Point syslog configurations at a TCP port.

---

## How it stores things

| What | Where |
| --- | --- |
| Configurations you create or edit | `etc/apps/eventgen_manager/local/eventgen.conf` |
| Sample files | `etc/apps/eventgen_manager/samples/` |
| Starter configurations | `etc/apps/eventgen_manager/default/eventgen.conf` |
| Engine settings | `etc/apps/eventgen_manager/local/inputs.conf` |
| Engine status and counters | `var/lib/splunk/modinputs/eventgen_manager_engine/status.json` |
| Engine log | `var/log/splunk/eventgen_manager_engine.log` |

Configuration is read and written through Splunk's own
`configs/conf-eventgen` endpoint, so permissions, conf-layer precedence, and
search head cluster replication behave exactly as they do for any other
Splunk configuration.

The editor never discards settings it does not recognise. If you have added a
key by hand that this app has no field for, it is listed on the Sample tab as
preserved and written back untouched when you save.

Configurations belonging to other apps are listed read-only. Use **Clone** to
copy one into a location you can edit.

### Where to run the engine

Run it on one instance per environment: a standalone instance, or a heavy
forwarder or single search head in a distributed deployment. In a search
head cluster, every member would run its own engine, so turn the input off
on all but one member (in that member's `local/inputs.conf`), or run the app
on a separate instance.

### Reinstalling the app resets the starter configurations

The starter configurations ship switched off in `default/`, and turning one on
writes `disabled = false` to `local/eventgen.conf`. Deleting the app directory
during a reinstall removes `local/` along with it, so the starters revert to
off and stop producing events. Extracting a new version over the existing
directory keeps `local/` intact.

Cloning a starter before changing it avoids this entirely: a clone exists only
in `local/`, with no `default` layer beneath it to fall back to.

### Keeping custom samples across upgrades

Sample files live in `samples/` inside the app, which is where the engine
looks by default and what keeps stanzas portable between instances.
Configurations themselves are safe across upgrades because they are written
to `local/`, but that convention does not extend to the samples folder.

If a sample file matters to you, either keep a copy outside Splunk, or point
the configuration at a directory of your own using the **Sample directory**
field on the Basics tab. An absolute path there is never touched by an app
upgrade.

---

## Notes on the preview

The preview runs the engine's own token replacement without sending anything
anywhere. Two things are approximations, and the interface says so where it
matters:

- Rate curves scale the reported event count rather than the wall-clock pace.
- Replay-timestamp offsets are derived from the events shown, not from a full
  pass over the sample file.

The preview also warns about anything the engine would refuse to run, such
as an unsupported output mode.

---

## Troubleshooting

**Configurations are enabled but no events appear.** Check **Generator
control**. It shows whether the engine is turned on, whether it is actually
reporting, and whether it is on standby because SA-Eventgen is still running.

**A configuration shows Error.** The reason is shown under the status, and
again in the **Warnings and errors** panel on Throughput. The engine retries
every minute, and immediately when you change the configuration or its
sample file.

**Events appear with the wrong timestamps.** The `earliest` and `latest`
settings decide the window timestamps land in. Setting both to `now` stamps
events at generation time. Check the `timezone` setting if offsets look
wrong; a format ending in `Z` needs `timezone = 0000`.

**A token does not replace anything.** The preview warns about tokens that
match nothing in the sample. Remember that a pattern with a capture group
replaces only the contents of the first group, and that tokens run in order,
so a later token sees the output of the earlier ones.

**HEC output fails with a certificate error.** Splunk's default HEC
certificate is self-signed. Install a trusted certificate, or untick
**Verify the receiver's certificate** for a test receiver.

**Permission errors when saving.** Creating and changing configurations needs
the `admin` or `sc_admin` role.

**Nothing to see on the Throughput page.** Those panels read
`index=_internal source=*eventgen_manager_engine.log*`. Confirm a
configuration has been running for at least 30 seconds and that your role
can search `_internal`.

---

## Binary File Declaration

This app contains no binary executables. Everything shipped is Python source,
JavaScript, CSS, XML, PNG icons, and plain-text sample data.

## A note on the sample data

Every address in the bundled sample files comes from the ranges RFC 5737 and
RFC 2606 reserve for documentation (`192.0.2.0/24`, `198.51.100.0/24`,
`203.0.113.0/24`, and `example.com`). Nothing in them refers to a real host,
network, or person.

---

## Release notes

### 2.0.0

Eventgen Manager now generates events itself. SA-Eventgen is no longer
required.

- Built-in generation engine, shipped as the `eventgen_manager_engine`
  modular input. Pure Python, so it runs on Linux, macOS, and Windows, on
  x86 and ARM, including platforms SA-Eventgen never supported
- Configuration changes apply within seconds, with no restart of anything.
  The 1.0 workaround of restarting SA-Eventgen's input on every change is
  gone
- Safe upgrade from SA-Eventgen: the engine waits on standby while
  SA-Eventgen is running, and Generator control switches over in one click
- Send test events from the editor to the configuration's real destination
  without turning it on
- Live per-configuration status on the Configurations page: state, events
  generated, last batch, and the reason for any failure
- `rated` replacements work; the starter JSON configuration now uses one
- New `seqfile` replacement, and `autotimestamp` support, with
  `autotimestampTime = now` to stamp events with the current time
- New random values: `weighted{...}`, `ipv4private`, `email`, `useragent`,
  and `uuid`
- Counters (`integerid`) carry on from their last value after a restart
- `verifySSL` setting for HEC and splunkstream receivers
- `syslogout` sends over TCP, and `udpout` is gone, since apps may not send
  UDP on Splunk Cloud or under app certification
- Throughput dashboard rebuilt on the engine's own metrics, filterable per
  configuration, with failed batches and runs that fell behind schedule
- The engine can run from the command line, outside Splunk
- Fixed: the structured application log starter wrote local time with a `Z`
  (UTC) suffix. It now sets `timezone = 0000`
- Removed from the editor: settings that only tuned SA-Eventgen's worker
  pools, and its plugin and template settings. Existing values are kept
  untouched in `eventgen.conf`

### 1.0.0

First release.

- Guided editor covering the full `eventgen.conf` setting surface, with
  fields shown conditionally by generation mode and output mode
- Live event preview with per-value highlighting, running read-only
- Token editor with ordering, and index renumbering so eventgen never sees a
  gap in the sequence
- Bucket editors for hour-of-day and day-of-week rate curves
- Sample file upload, editing, and deletion
- Generator control with health checks and one-click remediation
- Throughput dashboard measuring what actually reached an index
- Four starter configurations and six sample files, shipped turned off

---

## Licence

Apache License 2.0. See `LICENSE`.

Eventgen and Splunk are trademarks of Splunk LLC. Eventgen Manager is an
independent app that reads the eventgen.conf format. It is not produced or
endorsed by Splunk LLC.
