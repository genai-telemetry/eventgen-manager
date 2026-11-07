#
# inputs.conf.spec for Eventgen Manager
#

[eventgen_manager_engine://<name>]
* Runs the Eventgen Manager built-in generation engine.
* The engine reads eventgen.conf from every app and generates events for
  each configuration that is turned on. Only one engine runs per instance;
  if several inputs are defined, the first is used.

log_level = <string>
* How much the engine writes to
  $SPLUNK_HOME/var/log/splunk/eventgen_manager_engine.log.
* DEBUG, INFO, WARNING, or ERROR.
* Default: INFO

reload_interval = <integer>
* Seconds between checks for changed configurations. A configuration that is
  started, paused, or edited takes effect within this time.
* Minimum 2.
* Default: 10
