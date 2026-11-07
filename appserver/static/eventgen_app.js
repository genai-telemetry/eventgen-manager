/*
 * Eventgen Manager
 * Copyright 2026 Kamal Singh Bisht. Licensed under the Apache License 2.0.
 *
 * One bundle serves every page in the app. Splunk loads it through the
 * dashboard's script attribute; the page is chosen from getPageInfo().
 */

require([
  'jquery',
  'splunkjs/mvc/utils',
  'splunkjs/mvc/simplexml/ready!'
], function ($, utils) {
  'use strict';

  /* ==================================================================== */
  /* Environment                                                          */
  /* ==================================================================== */

  var page = utils.getPageInfo();
  var APP = page.app || 'eventgen_manager';
  var ROOT = (page.root ? '/' + page.root : '') + '/' + (page.locale || 'en-US');
  var SPLUNKD = ROOT + '/splunkd/__raw';
  var API = SPLUNKD + '/services/eventgen_manager/api';

  /* ==================================================================== */
  /* Small DOM helpers                                                    */
  /* ==================================================================== */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    var deferredValue;
    var key;

    if (attrs) {
      for (key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) { continue; }
        var value = attrs[key];
        if (value === null || value === undefined || value === false) { continue; }
        if (key === 'value' && 'value' in node) {
          /* A textarea takes its value from its content, not an attribute,
             so this is applied as a property once children are in place. */
          deferredValue = value;
        } else if (key === 'text') { node.textContent = value; }
        else if (key === 'html') { node.innerHTML = value; }
        else if (key === 'class') { node.className = value; }
        else if (key.indexOf('on') === 0 && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'dataset') {
          for (var d in value) {
            if (Object.prototype.hasOwnProperty.call(value, d)) {
              node.dataset[d] = value[d];
            }
          }
        } else { node.setAttribute(key, value === true ? '' : value); }
      }
    }

    append(node, children);

    if (deferredValue !== undefined) { node.value = deferredValue; }
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined) { return node; }
    if (!Array.isArray(children)) { children = [children]; }
    children.forEach(function (child) {
      if (child === null || child === undefined || child === false) { return; }
      node.appendChild(
        typeof child === 'string' || typeof child === 'number'
          ? document.createTextNode(String(child))
          : child
      );
    });
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) { node.removeChild(node.firstChild); }
    return node;
  }

  function bytes(value) {
    var n = Number(value) || 0;
    if (n < 1024) { return n + ' B'; }
    if (n < 1048576) { return (n / 1024).toFixed(1) + ' KB'; }
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function ago(epochSeconds) {
    var diff = Math.floor(Date.now() / 1000) - Number(epochSeconds || 0);
    if (diff < 60) { return 'just now'; }
    if (diff < 3600) { return Math.floor(diff / 60) + 'm ago'; }
    if (diff < 86400) { return Math.floor(diff / 3600) + 'h ago'; }
    return Math.floor(diff / 86400) + 'd ago';
  }

  function number(value) {
    return Number(value || 0).toLocaleString();
  }

  function isTrue(value) {
    return ['1', 'true', 'yes', 'on'].indexOf(
      String(value === undefined ? '' : value).trim().toLowerCase()) !== -1;
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  /* ==================================================================== */
  /* Toasts                                                               */
  /* ==================================================================== */

  var toastTimer = null;

  function toast(message, kind) {
    var existing = document.querySelector('.egm-toast');
    if (existing) { existing.remove(); }

    var node = el('div', {
      class: 'egm-toast' + (kind ? ' egm-toast-' + kind : ''),
      role: 'status',
      'aria-live': 'polite',
      text: message
    });
    document.body.appendChild(node);

    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.remove(); },
      kind === 'error' ? 7000 : 3500);
  }

  /* ==================================================================== */
  /* REST client                                                          */
  /* ==================================================================== */

  function csrfToken() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].trim();
      if (pair.indexOf('splunkweb_csrf_token') === 0) {
        return decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
      }
    }
    return '';
  }

  function request(method, url, options) {
    options = options || {};

    var headers = {
      'X-Splunk-Form-Key': csrfToken(),
      'X-Requested-With': 'XMLHttpRequest'
    };
    var body;

    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(options.form);
    }

    return fetch(url, {
      method: method,
      headers: headers,
      body: body,
      credentials: 'same-origin'
    }).then(function (response) {
      return response.text().then(function (text) {
        var parsed = null;
        if (text) {
          try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
        }
        if (!response.ok) {
          throw new Error(errorMessage(parsed, text, response.status));
        }
        return parsed;
      });
    });
  }

  function errorMessage(parsed, text, status) {
    if (parsed) {
      if (parsed.error) { return parsed.error; }
      if (parsed.messages && parsed.messages.length) {
        return parsed.messages.map(function (m) { return m.text; }).join(' ');
      }
    }
    if (text && text.length < 300 && text.indexOf('<') !== 0) { return text; }
    if (status === 401 || status === 403) {
      return 'You do not have permission to do that. This app needs the ' +
        'admin or sc_admin role.';
    }
    if (status === 404) { return 'That endpoint was not found (404).'; }
    return 'The request failed with status ' + status + '.';
  }

  function encodeForm(data) {
    var pairs = [];
    Object.keys(data).forEach(function (key) {
      var value = data[key];
      if (value === undefined || value === null) { return; }
      if (Array.isArray(value)) {
        value.forEach(function (item) {
          pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(item));
        });
      } else {
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      }
    });
    return pairs.join('&');
  }

  function query(params) {
    var encoded = encodeForm(params);
    return encoded ? '?' + encoded : '';
  }

  /* -- custom API ----------------------------------------------------- */

  var api = {
    health: function () {
      return request('GET', API + '/health');
    },
    apps: function () {
      return request('GET', API + '/apps');
    },
    samples: function (app) {
      return request('GET', API + '/samples' + query({ app: app }));
    },
    readSample: function (app, name, lines) {
      return request('GET', API + '/sample' +
        query({ app: app, name: name, lines: lines || 200 }));
    },
    writeSample: function (payload) {
      return request('POST', API + '/sample', { json: payload });
    },
    deleteSample: function (app, name) {
      return request('DELETE', API + '/sample' + query({ app: app, name: name }));
    },
    preview: function (payload) {
      return request('POST', API + '/preview', { json: payload });
    },
    status: function () {
      return request('GET', API + '/status');
    },
    testBatch: function (payload) {
      return request('POST', API + '/testbatch', { json: payload });
    }
  };

  /* -- eventgen.conf via Splunk's own configs endpoint ---------------- */

  var RESERVED_STANZAS = ['default', 'global'];

  var conf = {
    base: function (app) {
      return SPLUNKD + '/servicesNS/nobody/' +
        encodeURIComponent(app || APP) + '/configs/conf-eventgen';
    },

    list: function () {
      return request('GET', SPLUNKD +
        '/servicesNS/-/-/configs/conf-eventgen' +
        query({ output_mode: 'json', count: 0 })
      ).then(function (data) {
        return (data && data.entry ? data.entry : [])
          .filter(function (entry) {
            return RESERVED_STANZAS.indexOf(entry.name) === -1;
          })
          .map(function (entry) {
            var acl = entry.acl || {};
            return {
              name: entry.name,
              app: acl.app,
              sharing: acl.sharing,
              canWrite: acl.can_write !== false,
              removable: acl.removable !== false,
              content: entry.content || {}
            };
          });
      });
    },

    create: function (app, name, values) {
      var payload = { name: name, output_mode: 'json' };
      Object.keys(values).forEach(function (key) { payload[key] = values[key]; });
      return request('POST', conf.base(app), { form: payload });
    },

    update: function (app, name, values) {
      var payload = { output_mode: 'json' };
      Object.keys(values).forEach(function (key) { payload[key] = values[key]; });
      return request('POST',
        conf.base(app) + '/' + encodeURIComponent(name), { form: payload });
    },

    remove: function (app, name) {
      return request('DELETE',
        conf.base(app) + '/' + encodeURIComponent(name) +
        query({ output_mode: 'json' }));
    },

    /*
     * Splunk's conf endpoint can add and change keys but not remove them, so
     * a save that drops keys is done as a delete followed by a rebuild. The
     * previous values are held in memory and written back if the rebuild
     * fails, so a stanza is never left half-written.
     */
    save: function (app, name, values, originalValues, isNew, removable) {
      if (isNew) { return conf.create(app, name, values); }

      var removed = Object.keys(originalValues || {}).filter(function (key) {
        return !Object.prototype.hasOwnProperty.call(values, key);
      });

      if (!removed.length) { return conf.update(app, name, values); }

      // Splunk's conf endpoint can add and change keys but not remove them,
      // so dropping a key means deleting the stanza and writing it again.
      // That is only possible when the stanza exists solely in local. One
      // shipped in an app's default folder cannot be deleted, and attempting
      // it fails the whole save — including the changes that would have
      // worked. In that case, write what can be written and say plainly
      // which settings were left behind.
      if (removable === false) {
        return conf.update(app, name, values).then(function (result) {
          result = result || {};
          result.keptKeys = removed;
          return result;
        });
      }

      return conf.remove(app, name)
        .then(function () { return conf.create(app, name, values); })
        .catch(function (error) {
          return conf.create(app, name, originalValues)
            .then(function () {
              throw new Error('Could not save the changes, so the previous ' +
                'settings were restored. ' + error.message);
            }, function () {
              throw new Error('Could not save the changes and the previous ' +
                'settings could not be restored. Check eventgen.conf in ' +
                app + '. ' + error.message);
            });
        });
    }
  };

  /* -- The built-in engine's modular input ---------------------------- */

  /*
   * The engine re-reads eventgen.conf every few seconds, so a configuration
   * change needs no restart. Only the engine's own settings (log level,
   * reload interval) are applied by splunkd relaunching it, which it does by
   * itself whenever the input stanza changes.
   */
  var engine = {
    base: SPLUNKD + '/servicesNS/nobody/' + encodeURIComponent(APP) +
      '/data/inputs/eventgen_manager_engine',

    setEnabled: function (name, enabled) {
      return request('POST', engine.base + '/' + encodeURIComponent(name) +
        '/' + (enabled ? 'enable' : 'disable') + query({ output_mode: 'json' }));
    },
    update: function (name, values) {
      var payload = { output_mode: 'json' };
      Object.keys(values).forEach(function (key) { payload[key] = values[key]; });
      return request('POST',
        engine.base + '/' + encodeURIComponent(name), { form: payload });
    }
  };

  /* -- SA-Eventgen, only to switch it off ----------------------------- */

  /*
   * SA-Eventgen is no longer needed. If it is still running it reads the
   * same eventgen.conf, so the built-in engine waits rather than generate
   * every event twice. Turning SA-Eventgen's inputs off is the switch.
   */
  var saEventgen = {
    base: SPLUNKD + '/servicesNS/nobody/SA-Eventgen/data/inputs/' +
      'modinput_eventgen',

    disableAll: function (inputs) {
      var enabled = (inputs || []).filter(function (input) {
        return input.enabled;
      });
      return enabled.reduce(function (chain, input) {
        return chain.then(function () {
          return request('POST', saEventgen.base + '/' +
            encodeURIComponent(input.name) + '/disable' +
            query({ output_mode: 'json' }));
        });
      }, Promise.resolve());
    }
  };

  /* Live status keys are app/stanza, or app/stanza/file for a stanza whose
     name is a pattern matching several files. */
  function liveFor(status, item) {
    var stanzas = (status && status.stanzas) || {};
    var prefix = item.app + '/' + item.name;
    var found = [];
    Object.keys(stanzas).forEach(function (key) {
      if (key === prefix || key.indexOf(prefix + '/') === 0) {
        found.push(stanzas[key]);
      }
    });
    if (!found.length) { return null; }
    var merged = {
      state: found[0].state, events: 0, errors: 0, lastBatchAt: null,
      lastError: null, files: found.length
    };
    found.forEach(function (entry) {
      merged.events += Number(entry.events || 0);
      merged.errors += Number(entry.errors || 0);
      if (entry.lastBatchAt && (!merged.lastBatchAt ||
          entry.lastBatchAt > merged.lastBatchAt)) {
        merged.lastBatchAt = entry.lastBatchAt;
      }
      if (entry.state === 'error') {
        merged.state = 'error';
        merged.lastError = entry.lastError;
      } else if (!merged.lastError && entry.lastError &&
                 entry.lastErrorAt && entry.lastErrorAt >
                 (Date.now() / 1000) - 300) {
        merged.lastError = entry.lastError;
      }
    });
    return merged;
  }

  /* ==================================================================== */
  /* Shared building blocks                                               */
  /* ==================================================================== */

  function panel(title, bodyChildren, headExtras, flush) {
    var head = el('div', { class: 'egm-panel-head' }, [
      el('h3', { text: title })
    ]);
    if (headExtras) {
      head.appendChild(el('span', { class: 'egm-bar-spacer' }));
      append(head, headExtras);
    }
    return el('div', { class: 'egm-panel' }, [
      head,
      el('div', { class: 'egm-panel-body' + (flush ? ' egm-flush' : '') },
        bodyChildren)
    ]);
  }

  function note(kind, children) {
    return el('div', { class: 'egm-note egm-note-' + kind }, children);
  }

  function pill(text, kind) {
    return el('span', { class: 'egm-pill egm-pill-' + kind }, [
      el('span', { class: 'egm-dot' }),
      text
    ]);
  }

  function spinner(label) {
    return el('div', { class: 'egm-empty' }, [
      el('span', { class: 'egm-spinner' }),
      el('p', { text: label || 'Loading…', style: 'margin-top:10px' })
    ]);
  }

  function emptyState(title, message, action) {
    return el('div', { class: 'egm-empty' }, [
      el('h3', { text: title }),
      el('p', { text: message }),
      action
    ]);
  }

  function failure(container, error) {
    clear(container).appendChild(
      note('error', el('div', {}, [
        el('p', { html: '<strong>Something went wrong.</strong>' }),
        el('p', { text: error && error.message ? error.message : String(error) })
      ]))
    );
  }

  function confirmDialog(message, confirmLabel) {
    return new Promise(function (resolve) {
      var scrim = el('div', { class: 'egm-scrim' });
      var box = el('div', {
        class: 'egm-panel',
        role: 'alertdialog',
        style: 'position:fixed;z-index:1002;top:26%;left:50%;' +
          'transform:translateX(-50%);width:min(460px,92vw)'
      }, [
        el('div', { class: 'egm-panel-body' }, [
          el('p', { text: message, style: 'margin:0 0 14px' }),
          el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, [
            el('button', {
              class: 'egm-btn', text: 'Cancel',
              onclick: function () { close(false); }
            }),
            el('button', {
              class: 'egm-btn egm-btn-danger', text: confirmLabel || 'Delete',
              onclick: function () { close(true); }
            })
          ])
        ])
      ]);

      function close(result) {
        scrim.remove();
        box.remove();
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }

      function onKey(event) {
        if (event.key === 'Escape') { close(false); }
      }

      scrim.addEventListener('click', function () { close(false); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(scrim);
      document.body.appendChild(box);
      box.querySelector('.egm-btn-danger').focus();
    });
  }

  /* ==================================================================== */
  /* Setting schema                                                       */
  /*                                                                      */
  /* Every field the editor can write, grouped into the tabs of the       */
  /* stanza editor. "when" hides a field until the setting it depends on  */
  /* is relevant, so the form only ever shows what applies.               */
  /* ==================================================================== */

  var OUTPUT_MODES = [
    ['modinput', 'Index on this Splunk instance (default)'],
    ['splunkstream', 'Splunk REST — send to another Splunk instance'],
    ['httpevent', 'HTTP Event Collector'],
    ['file', 'Write to a file'],
    ['spool', 'Drop files in a spool directory'],
    ['syslogout', 'Syslog over TCP'],
    ['tcpout', 'Raw TCP'],
    ['stdout', 'Standard output — for troubleshooting'],
    ['devnull', 'Discard — measure generation cost only']
  ];

  var REPLACEMENT_TYPES = [
    ['static', 'Static — always the same value'],
    ['timestamp', 'Timestamp — a time between earliest and latest'],
    ['replaytimestamp', 'Replay timestamp — keep gaps between events'],
    ['random', 'Random — a new value each time'],
    ['rated', 'Rated — a random number scaled by the rate curves'],
    ['file', 'From a file — a random line'],
    ['mvfile', 'From a file column — a random line, one column'],
    ['integerid', 'Counter — increments on every event'],
    ['seqfile', 'From a file, in order — the next line each time']
  ];

  /* Suggestions shown under the replacement box, per type. */
  var REPLACEMENT_HELP = {
    static: 'The literal text to insert, such as web01.example.com.',
    timestamp: 'A strftime format, such as %Y-%m-%dT%H:%M:%S or ' +
      '%d/%b/%Y:%H:%M:%S %z. Use %s for epoch seconds.',
    replaytimestamp: 'A strftime format matching the original timestamp, or ' +
      'a JSON list of formats to try.',
    random: 'One of: guid, ipv4, ipv4private, ipv6, mac, email, ' +
      'useragent, integer[1:100], float[0.0:10.0], string(8), hex(12), ' +
      'list["a","b"], or weighted{"200": 90, "404": 8, "500": 2} to pick ' +
      'values in proportion.',
    rated: 'integer[1:100] or float[0.0:10.0], multiplied by the rate ' +
      'curves on the Rate tab, so values rise and fall with traffic.',
    file: 'A sample file name, such as users.sample, or a full path.',
    mvfile: 'A file and a column number, such as users.sample:2. Columns ' +
      'start at 1. Tokens reading the same file share a row.',
    integerid: 'The number to start counting from, such as 1000. The ' +
      'engine remembers where it got to, so a restart does not repeat ' +
      'numbers.',
    seqfile: 'A sample file name. Lines are used in order and the file ' +
      'starts again from the top when it runs out.'
  };

  var SECTIONS = [
    {
      id: 'basics',
      label: 'Basics',
      fields: [
        {
          key: 'sampleDir', label: 'Sample directory', type: 'text',
          placeholder: 'Leave empty to use this app\'s samples folder',
          help: 'Where the sample file lives. Relative paths are resolved ' +
            'from the folder holding eventgen.conf. Leave it empty unless ' +
            'your samples sit somewhere unusual.'
        },
        {
          key: 'mode', label: 'Generation mode', type: 'select',
          options: [
            ['sample', 'Sample — emit a batch on every interval'],
            ['replay', 'Replay — play the file back at its original pace']
          ],
          fallback: 'sample',
          help: 'Sample mode repeats the file forever. Replay mode walks ' +
            'through it once, preserving the gaps between events.'
        },
        {
          key: 'sampletype', label: 'Sample format', type: 'select',
          options: [
            ['raw', 'Raw — one event per line'],
            ['csv', 'CSV — a header row plus a _raw column']
          ],
          fallback: 'raw',
          help: 'CSV samples can override host, source, sourcetype, and ' +
            'index per event using columns of those names.'
        },
        {
          key: 'autotimestamp', label: 'Detect timestamps automatically',
          type: 'boolean',
          help: 'Finds the first ISO 8601, web log, syslog, or US-style ' +
            'timestamp in each event and replaces it with the generated ' +
            'time, keeping its format. Handy for a quick start; explicit ' +
            'tokens give you more control.'
        },
        {
          key: 'autotimestampTime', label: 'Timestamp to write',
          type: 'select',
          options: [
            ['generated', 'Generated time — within earliest and latest'],
            ['now', 'Current time — the moment each event is sent']
          ],
          fallback: 'generated',
          help: 'Used when Detect timestamps automatically is ticked. ' +
            'Current time ignores earliest, latest, and backfill, and ' +
            'sets the event time to match, so detections that search the ' +
            'last few minutes see the event right away.'
        }
      ]
    },

    {
      id: 'volume',
      label: 'Volume & timing',
      fields: [
        {
          key: 'interval', label: 'Interval (seconds)', type: 'number',
          fallback: '60', min: 0,
          help: 'How often a batch is produced. 0 turns off repetition.'
        },
        {
          key: 'count', label: 'Events per interval', type: 'number',
          fallback: '0', min: 0,
          help: '0 means the whole sample file is emitted each time.'
        },
        {
          key: 'perDayVolume', label: 'Target volume (GB per day)',
          type: 'text',
          help: 'Set this instead of a count to aim for a data volume. ' +
            'When it is set, the count is ignored.'
        },
        {
          key: 'delay', label: 'Startup delay (seconds)', type: 'number',
          fallback: '0', min: 0,
          help: 'Waits this long before the first batch. Use it to stagger ' +
            'several configurations that would otherwise fire together.'
        },
        {
          key: 'randomizeCount', label: 'Count jitter', type: 'text',
          placeholder: '0.2',
          help: 'A fraction that varies the count either way. 0.2 gives ' +
            'plus or minus twenty percent.'
        },
        {
          key: 'randomizeEvents', label: 'Shuffle events', type: 'boolean',
          help: 'Picks lines from the sample in random order. Not available ' +
            'for CSV samples or replay mode.'
        },
        {
          key: 'earliest', label: 'Earliest event time', type: 'text',
          fallback: 'now',
          help: 'Splunk relative time, such as now, -60m, or -1h@h. ' +
            'Timestamps land between earliest and latest.'
        },
        {
          key: 'latest', label: 'Latest event time', type: 'text',
          fallback: 'now',
          help: 'Splunk relative time, such as now or -5m.'
        },
        {
          key: 'timezone', label: 'Timezone', type: 'text',
          placeholder: 'local',
          help: 'local for the server zone, 0000 for UTC, or an offset ' +
            'such as -0500 or +0530.'
        },
        {
          key: 'breaker', label: 'Event breaker', type: 'text',
          placeholder: '[^\\r\\n\\s]+',
          help: 'A regular expression marking event boundaries. Leave it ' +
            'empty to treat each line as one event. Use \\r*\\n\\r*\\n for ' +
            'blank-line separated multi-line events.'
        },
        {
          key: 'bundlelines', label: 'Treat the whole file as one event',
          type: 'boolean',
          help: 'Overrides the breaker. Useful for replaying a single ' +
            'multi-line transaction over and over.'
        },
        {
          key: 'timeMultiple', label: 'Replay speed factor', type: 'text',
          when: function (values) { return values.mode === 'replay'; },
          placeholder: '1',
          help: 'Stretches replay timing. 2 plays back at half speed, 0.5 ' +
            'plays back twice as fast.'
        },
        {
          key: 'timeField', label: 'Timestamp field', type: 'text',
          when: function (values) { return values.mode === 'replay'; },
          placeholder: '_raw',
          help: 'Which field holds the time to replay from. For CSV ' +
            'samples this is often a column other than _raw.'
        },
        {
          key: 'backfill', label: 'Backfill from', type: 'text',
          placeholder: '-1h',
          help: 'Generates history first, covering this far back one ' +
            'interval at a time, before switching to live generation. ' +
            'Sample mode only.'
        },
        {
          key: 'end', label: 'Stop after', type: 'text',
          help: 'A whole number of intervals (or replay passes), or a time ' +
            'such as +2h. Leave empty to run indefinitely.'
        }
      ]
    },

    {
      id: 'rate',
      label: 'Rate',
      intro: 'Rate curves scale the event count by the time of day, day of ' +
        'week, and so on. Every curve that matches is multiplied together. ' +
        'Leave them empty for a flat rate.',
      fields: [
        {
          key: 'hourOfDayRate', label: 'Hour of day', type: 'rate',
          buckets: 24, bucketLabel: 'Hour',
          help: 'Keys 0 through 23. A value of 0.5 halves the count in ' +
            'that hour.'
        },
        {
          key: 'dayOfWeekRate', label: 'Day of week', type: 'rate',
          buckets: 7, bucketLabel: 'Day',
          names: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
          help: 'Keys 0 through 6, where 0 is Sunday.'
        },
        {
          key: 'minuteOfHourRate', label: 'Minute of hour', type: 'json',
          help: 'Keys 0 through 59, as JSON. Use this for sawtooth or ' +
            'burst patterns within each hour.'
        },
        {
          key: 'dayOfMonthRate', label: 'Day of month', type: 'json',
          help: 'Keys 1 through 31, as JSON.'
        },
        {
          key: 'monthOfYearRate', label: 'Month of year', type: 'json',
          help: 'Keys 1 through 12, as JSON.'
        }
      ]
    },

    {
      id: 'output',
      label: 'Output',
      fields: [
        {
          key: 'outputMode', label: 'Send events to', type: 'select',
          options: OUTPUT_MODES, fallback: 'modinput',
          help: 'Where generated events go. The fields below change to ' +
            'match your choice.'
        },

        /* Splunk metadata — meaningful for the indexing outputs. */
        {
          key: 'index', label: 'Index', type: 'text', fallback: 'main',
          when: function (v) {
            return ['modinput', 'splunkstream', 'httpevent'].indexOf(
              v.outputMode || 'modinput') !== -1;
          }
        },
        {
          key: 'sourcetype', label: 'Sourcetype', type: 'text',
          fallback: 'eventgen',
          when: function (v) {
            return ['modinput', 'splunkstream', 'httpevent'].indexOf(
              v.outputMode || 'modinput') !== -1;
          }
        },
        {
          key: 'source', label: 'Source', type: 'text',
          placeholder: 'Defaults to the sample file name',
          when: function (v) {
            return ['modinput', 'splunkstream', 'httpevent'].indexOf(
              v.outputMode || 'modinput') !== -1;
          }
        },
        {
          key: 'host', label: 'Host', type: 'text', placeholder: '127.0.0.1',
          when: function (v) {
            return ['splunkstream', 'syslogout'].indexOf(v.outputMode) !== -1;
          },
          help: 'The host value stamped on each event.'
        },
        {
          key: 'hostRegex', label: 'Host pattern', type: 'text',
          when: function (v) { return v.outputMode === 'splunkstream'; },
          help: 'Pull the host out of the event itself. Used only when no ' +
            'host is set above.'
        },

        /* File and spool */
        {
          key: 'fileName', label: 'File path', type: 'text',
          when: function (v) { return v.outputMode === 'file'; },
          help: 'The full path to write to. The file rotates as it grows.'
        },
        {
          key: 'fileMaxBytes', label: 'Rotate at (bytes)', type: 'number',
          fallback: '10485760',
          when: function (v) { return v.outputMode === 'file'; }
        },
        {
          key: 'fileBackupFiles', label: 'Files to keep', type: 'number',
          fallback: '5',
          when: function (v) { return v.outputMode === 'file'; }
        },
        {
          key: 'spoolDir', label: 'Spool directory', type: 'text',
          placeholder: '$SPLUNK_HOME/var/spool/splunk',
          when: function (v) { return v.outputMode === 'spool'; }
        },
        {
          key: 'spoolFile', label: 'Spool file name', type: 'text',
          placeholder: 'The sample file name',
          when: function (v) { return v.outputMode === 'spool'; }
        },

        /* Splunk stream and s2s */
        {
          key: 'splunkHost', label: 'Splunk host', type: 'text',
          when: function (v) {
            return ['splunkstream', 's2s'].indexOf(v.outputMode) !== -1;
          },
          help: 'One hostname, or a JSON list such as ["a.example", ' +
            '"b.example"] to spread events across indexers.'
        },
        {
          key: 'splunkPort', label: 'Splunk port', type: 'text',
          placeholder: '8089',
          when: function (v) {
            return ['splunkstream', 's2s'].indexOf(v.outputMode) !== -1;
          }
        },
        {
          key: 'splunkMethod', label: 'Protocol', type: 'select',
          options: [['https', 'https'], ['http', 'http']], fallback: 'https',
          when: function (v) { return v.outputMode === 'splunkstream'; }
        },
        {
          key: 'splunkUser', label: 'Username', type: 'text',
          when: function (v) { return v.outputMode === 'splunkstream'; }
        },
        {
          key: 'splunkPass', label: 'Password', type: 'password',
          when: function (v) { return v.outputMode === 'splunkstream'; },
          help: 'Stored in plain text in eventgen.conf. Prefer a dedicated ' +
            'account with only the rights it needs.'
        },

        /* HTTP Event Collector */
        {
          key: 'httpeventServers', label: 'Collector endpoints', type: 'json',
          when: function (v) { return v.outputMode === 'httpevent'; },
          help: 'JSON, for example {"servers":[{"protocol":"https",' +
            '"address":"127.0.0.1","port":"8088","key":"YOUR-TOKEN"}]}'
        },
        {
          key: 'httpeventOutputMode', label: 'Distribution', type: 'select',
          options: [
            ['roundrobin', 'Round robin — one server per batch'],
            ['mirror', 'Mirror — every server gets every event']
          ],
          when: function (v) { return v.outputMode === 'httpevent'; }
        },
        {
          key: 'httpeventMaxPayloadSize', label: 'Maximum payload (bytes)',
          type: 'number',
          when: function (v) { return v.outputMode === 'httpevent'; }
        },
        {
          key: 'verifySSL', label: 'Verify the receiver\u2019s certificate',
          type: 'boolean', fallback: 'true',
          when: function (v) {
            return ['httpevent', 'splunkstream'].indexOf(v.outputMode) !== -1;
          },
          help: 'On unless you turn it off. Splunk ships HEC and its ' +
            'management port with a self-signed certificate, which fails ' +
            'verification; turn this off only for such a test receiver.'
        },

        /* Syslog and TCP */
        {
          key: 'syslogDestinationHost', label: 'Syslog host', type: 'text',
          placeholder: '127.0.0.1',
          when: function (v) { return v.outputMode === 'syslogout'; }
        },
        {
          key: 'syslogDestinationPort', label: 'Syslog port', type: 'text',
          placeholder: '1514',
          when: function (v) { return v.outputMode === 'syslogout'; },
          help: 'A TCP port. Messages are sent one per line, which ' +
            'syslog-ng, rsyslog, and Splunk TCP inputs all accept.'
        },
        {
          key: 'syslogAddHeader', label: 'Add an RFC 3164 header',
          type: 'boolean',
          when: function (v) { return v.outputMode === 'syslogout'; },
          help: 'Prefixes each message with a header carrying the host set ' +
            'above, so the receiver sees the sample\'s host rather than ' +
            'the generating machine.'
        },
        {
          key: 'tcpDestinationHost', label: 'TCP host', type: 'text',
          placeholder: '127.0.0.1',
          when: function (v) { return v.outputMode === 'tcpout'; }
        },
        {
          key: 'tcpDestinationPort', label: 'TCP port', type: 'text',
          placeholder: '3333',
          when: function (v) { return v.outputMode === 'tcpout'; }
        }
      ]
    }
  ];

  /* Keys the editor owns directly; anything else in a stanza is preserved
     untouched so a hand-written setting is never silently dropped. */
  var KNOWN_KEYS = (function () {
    var keys = { disabled: true, 'host.token': true, 'host.replacement': true };
    SECTIONS.forEach(function (section) {
      section.fields.forEach(function (field) { keys[field.key] = true; });
    });
    return keys;
  }());

  function isTokenKey(key) {
    return /^token\.\d+\.(token|replacementType|replacement)$/.test(key);
  }
  /* ==================================================================== */
  /* Stanza editor                                                        */
  /* ==================================================================== */

  function openEditor(options) {
    var isNew = !!options.isNew;
    var source = options.stanza || {};
    var targetApp = source.app || APP;

    /* -- state ------------------------------------------------------- */

    var values = {};
    var tokens = [];
    var extras = {};          /* keys we do not manage, preserved verbatim */
    var originalValues = {};

    Object.keys(source.content || {}).forEach(function (key) {
      var value = source.content[key];
      if (value === null || value === undefined) { return; }
      value = String(value);
      originalValues[key] = value;

      if (isTokenKey(key)) { return; }         /* gathered below */
      if (KNOWN_KEYS[key]) { values[key] = value; return; }
      if (key.indexOf('eai:') === 0 || key === 'disabled') { return; }
      extras[key] = value;
    });

    tokens = collectTokens(source.content || {});
    values.disabled = String(isTrue((source.content || {}).disabled));

    var stanzaName = isNew ? '' : source.name;
    var activeTab = 'identity';
    var previewSample = { mode: 'file', name: stanzaName, text: '' };
    var sampleFiles = [];
    var validationErrors = {};

    /* -- shell ------------------------------------------------------- */

    var scrim = el('div', { class: 'egm-scrim' });

    var titleNode = el('h2', {
      text: isNew ? 'New configuration' : 'Edit ' + source.name
    });
    var appNode = el('span', { class: 'egm-hint' });
    var formHost = el('div');
    var previewHost = el('div');
    var saveButton = el('button', {
      class: 'egm-btn egm-btn-primary',
      text: isNew ? 'Create configuration' : 'Save changes',
      onclick: save
    });

    var drawer = el('div', {
      class: 'egm-drawer egm',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': isNew ? 'New configuration' : 'Edit configuration'
    }, [
      el('div', { class: 'egm-drawer-head' }, [
        titleNode,
        appNode,
        el('span', { class: 'egm-bar-spacer' }),
        el('button', {
          class: 'egm-close', 'aria-label': 'Close', text: '\u00d7',
          onclick: close
        })
      ]),
      el('div', { class: 'egm-drawer-body' }, [
        el('div', { class: 'egm-split' }, [formHost, previewHost])
      ]),
      el('div', { class: 'egm-drawer-foot' }, [
        el('label', { class: 'egm-check' }, [
          el('input', {
            type: 'checkbox',
            checked: !isTrue(values.disabled),
            onchange: function (event) {
              values.disabled = String(!event.target.checked);
            }
          }),
          'Generate events with this configuration'
        ]),
        el('span', { class: 'egm-bar-spacer' }),
        el('button', { class: 'egm-btn', text: 'Cancel', onclick: close }),
        saveButton
      ])
    ]);

    function close() {
      document.removeEventListener('keydown', onKey);
      scrim.remove();
      drawer.remove();
    }

    function onKey(event) {
      if (event.key === 'Escape') { close(); }
    }

    scrim.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(scrim);
    document.body.appendChild(drawer);

    /* -- data -------------------------------------------------------- */

    loadSamples();

    function loadSamples() {
      api.samples(targetApp).then(function (data) {
        sampleFiles = data.files || [];
        renderForm();
        refreshPreview();
      }).catch(function () {
        sampleFiles = [];
        renderForm();
      });
    }

    /* -- form -------------------------------------------------------- */

    function renderForm() {
      var tabs = el('div', { class: 'egm-tabs', role: 'tablist' });
      var body = el('div', { class: 'egm-tabpanel', role: 'tabpanel' });

      var tabDefs = [{ id: 'identity', label: 'Sample' }]
        .concat(SECTIONS.map(function (section) {
          return { id: section.id, label: section.label };
        }))
        .concat([
          { id: 'tokens', label: 'Tokens', count: tokens.length },
          { id: 'raw', label: 'Review' }
        ]);

      tabDefs.forEach(function (def) {
        var button = el('button', {
          class: 'egm-tab', role: 'tab', type: 'button',
          'aria-selected': String(activeTab === def.id),
          onclick: function () { activeTab = def.id; renderForm(); }
        }, [def.label]);

        if (def.count) {
          button.appendChild(
            el('span', { class: 'egm-tab-count', text: String(def.count) }));
        }
        tabs.appendChild(button);
      });

      if (activeTab === 'identity') { renderIdentityTab(body); }
      else if (activeTab === 'tokens') { renderTokensTab(body); }
      else if (activeTab === 'raw') { renderRawTab(body); }
      else { renderSectionTab(body, activeTab); }

      clear(formHost).appendChild(
        el('div', { class: 'egm-panel' }, [
          el('div', { class: 'egm-panel-body' }, [tabs, body])
        ])
      );

      appNode.textContent = 'in ' + targetApp;
    }

    function renderIdentityTab(body) {
      var nameField = el('div', { class: 'egm-field' }, [
        el('label', {
          class: 'egm-label', for: 'egm-stanza-name',
          text: 'Sample file'
        }),
        el('input', {
          class: 'egm-input' +
            (validationErrors.name ? ' egm-invalid' : ''),
          id: 'egm-stanza-name',
          type: 'text',
          value: stanzaName,
          disabled: !isNew,
          list: 'egm-sample-list',
          placeholder: 'access_combined.sample',
          oninput: function (event) {
            stanzaName = event.target.value.trim();
            delete validationErrors.name;
            if (previewSample.mode === 'file') {
              previewSample.name = stanzaName;
            }
            schedulePreview();
          }
        }),
        el('datalist', { id: 'egm-sample-list' },
          sampleFiles.map(function (file) {
            return el('option', { value: file.name });
          })),
        el('p', {
          class: 'egm-hint',
          text: isNew
            ? 'The name of a file in the samples folder. It can also be a ' +
              'regular expression, which applies the settings to every ' +
              'matching file.'
            : 'The sample name cannot be changed. Clone the configuration ' +
              'to use a different sample.'
        })
      ]);

      if (validationErrors.name) {
        nameField.appendChild(
          el('p', { class: 'egm-field-error', text: validationErrors.name }));
      }

      body.appendChild(nameField);

      if (isNew && sampleFiles.length === 0) {
        body.appendChild(note('warn', el('div', {}, [
          el('p', {
            html: '<strong>No sample files yet.</strong>'
          }),
          el('p', {
            text: 'Add one on the Sample data page, or type a name here and ' +
              'create the file afterwards.'
          })
        ])));
      }

      if (sampleFiles.length) {
        var table = el('table', { class: 'egm-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: 'Available samples' }),
            el('th', { text: 'Lines' }),
            el('th', { text: 'Size' }),
            el('th', {})
          ])),
          el('tbody', {}, sampleFiles.map(function (file) {
            return el('tr', {}, [
              el('td', { class: 'egm-mono', text: file.name }),
              el('td', { text: number(file.lines) }),
              el('td', { text: bytes(file.bytes) }),
              el('td', { class: 'egm-actions' }, [
                el('button', {
                  class: 'egm-btn egm-btn-sm', type: 'button',
                  text: isNew ? 'Use this' : 'Preview with this',
                  onclick: function () {
                    if (isNew) {
                      stanzaName = file.name;
                    }
                    previewSample = { mode: 'file', name: file.name, text: '' };
                    renderForm();
                    refreshPreview();
                  }
                })
              ])
            ]);
          }))
        ]);
        body.appendChild(el('div', { style: 'margin-top:18px' }, [table]));
      }

      if (Object.keys(extras).length) {
        body.appendChild(el('div', { style: 'margin-top:18px' }, [
          note('info', el('div', {}, [
            el('p', { html: '<strong>Settings kept as they are</strong>' }),
            el('p', {
              text: 'These were written by hand and are not editable here. ' +
                'They are preserved exactly when you save: ' +
                Object.keys(extras).join(', ') + '.'
            })
          ]))
        ]));
      }
    }

    function renderSectionTab(body, sectionId) {
      var section = SECTIONS.filter(function (item) {
        return item.id === sectionId;
      })[0];
      if (!section) { return; }

      if (section.intro) {
        body.appendChild(el('p', {
          class: 'egm-hint',
          text: section.intro,
          style: 'margin:0 0 14px'
        }));
      }

      var grid = el('div', { class: 'egm-row' });
      var wide = el('div');

      section.fields.forEach(function (field) {
        if (field.when && !field.when(values)) { return; }
        var node = renderField(field);
        if (field.type === 'json' || field.type === 'rate') {
          wide.appendChild(node);
        } else {
          grid.appendChild(node);
        }
      });

      body.appendChild(grid);
      body.appendChild(wide);
    }

    function renderField(field) {
      var id = 'egm-f-' + field.key;
      var current = values[field.key];
      var wrapper = el('div', { class: 'egm-field' });

      var label = el('label', { class: 'egm-label', for: id }, [
        field.label,
        el('code', { text: field.key })
      ]);

      if (field.type === 'boolean') {
        wrapper.appendChild(el('label', { class: 'egm-check' }, [
          el('input', {
            type: 'checkbox', id: id,
            checked: current === undefined
              ? isTrue(field.fallback) : isTrue(current),
            onchange: function (event) {
              setValue(field.key, event.target.checked ? 'true' : 'false',
                field.fallback || 'false');
              renderForm();
              schedulePreview();
            }
          }),
          field.label,
          el('code', { text: field.key })
        ]));
      } else if (field.type === 'select') {
        wrapper.appendChild(label);
        var select = el('select', {
          class: 'egm-select', id: id,
          onchange: function (event) {
            setValue(field.key, event.target.value, field.fallback);
            renderForm();
            schedulePreview();
          }
        }, field.options.map(function (option) {
          return el('option', {
            value: option[0],
            selected: (current || field.fallback) === option[0]
          }, [option[1]]);
        }));
        wrapper.appendChild(select);
      } else if (field.type === 'json') {
        wrapper.appendChild(label);
        wrapper.appendChild(el('textarea', {
          class: 'egm-textarea' +
            (validationErrors[field.key] ? ' egm-invalid' : ''),
          id: id, rows: 3, spellcheck: 'false',
          value: current || '',
          oninput: function (event) {
            setValue(field.key, event.target.value.trim(), '');
            validateJson(field.key, event.target.value);
            schedulePreview();
          }
        }));
      } else if (field.type === 'rate') {
        wrapper.appendChild(label);
        wrapper.appendChild(renderRateEditor(field, id));
      } else {
        wrapper.appendChild(label);
        wrapper.appendChild(el('input', {
          class: 'egm-input', id: id,
          type: field.type === 'password' ? 'password'
            : (field.type === 'number' ? 'number' : 'text'),
          min: field.min,
          value: current === undefined ? '' : current,
          placeholder: field.placeholder ||
            (field.fallback ? field.fallback : ''),
          oninput: function (event) {
            setValue(field.key, event.target.value.trim(), '');
            schedulePreview();
          }
        }));
      }

      if (validationErrors[field.key]) {
        wrapper.appendChild(el('p', {
          class: 'egm-field-error', text: validationErrors[field.key]
        }));
      } else if (field.help) {
        wrapper.appendChild(el('p', { class: 'egm-hint', text: field.help }));
      }

      return wrapper;
    }

    /* Rate curves get real inputs rather than raw JSON: the shape of the
       curve is the point, and typing 24 keys by hand invites typos. */
    function renderRateEditor(field, id) {
      var parsed = {};
      try {
        parsed = values[field.key] ? JSON.parse(values[field.key]) : {};
      } catch (error) {
        return el('div', {}, [
          el('textarea', {
            class: 'egm-textarea egm-invalid', id: id, rows: 3,
            value: values[field.key] || '',
            oninput: function (event) {
              setValue(field.key, event.target.value.trim(), '');
              validateJson(field.key, event.target.value);
            }
          }),
          el('p', {
            class: 'egm-field-error',
            text: 'This is not valid JSON, so the sliders are hidden. Fix ' +
              'the text or clear it to start again.'
          })
        ]);
      }

      var container = el('div', {
        style: 'display:grid;grid-template-columns:repeat(auto-fill,' +
          'minmax(58px,1fr));gap:6px'
      });

      for (var bucket = 0; bucket < field.buckets; bucket++) {
        container.appendChild(rateBucket(field, bucket, parsed));
      }

      return el('div', {}, [
        container,
        el('div', { style: 'margin-top:8px;display:flex;gap:8px' }, [
          el('button', {
            class: 'egm-btn egm-btn-sm', type: 'button', text: 'Reset to flat',
            onclick: function () {
              setValue(field.key, '', '');
              renderForm();
              schedulePreview();
            }
          })
        ])
      ]);
    }

    function rateBucket(field, bucket, parsed) {
      var key = String(bucket);
      var label = field.names ? field.names[bucket] : String(bucket);
      var value = parsed[key] === undefined ? 1 : parsed[key];

      return el('div', {}, [
        el('label', {
          class: 'egm-eyebrow',
          style: 'display:block;text-align:center',
          for: 'egm-rate-' + field.key + '-' + bucket,
          text: label
        }),
        el('input', {
          class: 'egm-input',
          id: 'egm-rate-' + field.key + '-' + bucket,
          type: 'number', step: '0.05', min: '0', value: value,
          style: 'padding:3px 4px;text-align:center',
          onchange: function (event) {
            var next = Number(event.target.value);
            if (isNaN(next) || next < 0) { next = 1; }
            parsed[key] = next;

            var allFlat = true;
            for (var i = 0; i < field.buckets; i++) {
              if (parsed[String(i)] !== undefined &&
                  Number(parsed[String(i)]) !== 1) {
                allFlat = false;
                break;
              }
            }

            if (allFlat) {
              setValue(field.key, '', '');
            } else {
              var complete = {};
              for (var j = 0; j < field.buckets; j++) {
                var k = String(j);
                complete[k] = parsed[k] === undefined ? 1 : Number(parsed[k]);
              }
              setValue(field.key, JSON.stringify(complete), '');
            }
            schedulePreview();
          }
        })
      ]);
    }

    function setValue(key, value, fallback) {
      if (value === '' || value === undefined ||
          (fallback !== undefined && fallback !== '' && value === fallback &&
           !Object.prototype.hasOwnProperty.call(originalValues, key))) {
        delete values[key];
      } else {
        values[key] = value;
      }
    }

    function validateJson(key, text) {
      if (!text || !text.trim()) { delete validationErrors[key]; return true; }
      try {
        JSON.parse(text);
        delete validationErrors[key];
        return true;
      } catch (error) {
        validationErrors[key] = 'This is not valid JSON: ' + error.message;
        return false;
      }
    }

    /* -- tokens ------------------------------------------------------ */

    function renderTokensTab(body) {
      body.appendChild(el('p', {
        class: 'egm-hint',
        style: 'margin:0 0 14px',
        text: 'Tokens find text in the sample and swap it for something ' +
          'generated. They run in order, so a later token sees the result ' +
          'of the ones before it. If the pattern has a capture group, only ' +
          'that group is replaced.'
      }));

      if (!tokens.length) {
        body.appendChild(emptyState(
          'No tokens yet',
          'Without tokens, every event is emitted exactly as it appears in ' +
            'the sample file, including its original timestamps.',
          el('button', {
            class: 'egm-btn egm-btn-primary', type: 'button',
            text: 'Add the first token',
            onclick: addToken
          })));
        return;
      }

      tokens.forEach(function (token, index) {
        body.appendChild(renderToken(token, index));
      });

      body.appendChild(el('button', {
        class: 'egm-btn', type: 'button', text: 'Add token', onclick: addToken
      }));
    }

    function renderToken(token, index) {
      var help = REPLACEMENT_HELP[token.replacementType] || '';

      return el('div', { class: 'egm-token' }, [
        el('div', { class: 'egm-token-head' }, [
          el('span', { class: 'egm-token-index', text: 'token.' + index }),
          el('span', { class: 'egm-bar-spacer' }),
          el('button', {
            class: 'egm-btn egm-btn-sm', type: 'button', text: '\u2191',
            'aria-label': 'Move token ' + index + ' earlier',
            disabled: index === 0,
            onclick: function () { moveToken(index, -1); }
          }),
          el('button', {
            class: 'egm-btn egm-btn-sm', type: 'button', text: '\u2193',
            'aria-label': 'Move token ' + index + ' later',
            disabled: index === tokens.length - 1,
            onclick: function () { moveToken(index, 1); }
          }),
          el('button', {
            class: 'egm-btn egm-btn-sm egm-btn-danger', type: 'button',
            text: 'Remove',
            onclick: function () { removeToken(index); }
          })
        ]),
        el('div', { class: 'egm-token-body' }, [
          el('div', { class: 'egm-row' }, [
            el('div', { class: 'egm-field' }, [
              el('label', { class: 'egm-label', text: 'Find this pattern' }),
              el('input', {
                class: 'egm-input egm-mono', type: 'text',
                value: token.token || '',
                placeholder: '\\d+\\.\\d+\\.\\d+\\.\\d+',
                spellcheck: 'false',
                oninput: function (event) {
                  token.token = event.target.value;
                  schedulePreview();
                }
              })
            ]),
            el('div', { class: 'egm-field' }, [
              el('label', { class: 'egm-label', text: 'Replace it with' }),
              el('select', {
                class: 'egm-select',
                onchange: function (event) {
                  token.replacementType = event.target.value;
                  renderForm();
                  schedulePreview();
                }
              }, REPLACEMENT_TYPES.map(function (option) {
                return el('option', {
                  value: option[0],
                  selected: token.replacementType === option[0]
                }, [option[1]]);
              }))
            ]),
            el('div', { class: 'egm-field' }, [
              el('label', { class: 'egm-label', text: 'Value' }),
              el('input', {
                class: 'egm-input egm-mono', type: 'text',
                value: token.replacement || '',
                spellcheck: 'false',
                oninput: function (event) {
                  token.replacement = event.target.value;
                  schedulePreview();
                }
              })
            ])
          ]),
          help ? el('p', { class: 'egm-hint', text: help }) : null
        ])
      ]);
    }

    function addToken() {
      tokens.push({
        token: '', replacementType: 'static', replacement: ''
      });
      renderForm();
    }

    function removeToken(index) {
      tokens.splice(index, 1);
      renderForm();
      schedulePreview();
    }

    function moveToken(index, offset) {
      var target = index + offset;
      if (target < 0 || target >= tokens.length) { return; }
      var moved = tokens.splice(index, 1)[0];
      tokens.splice(target, 0, moved);
      renderForm();
      schedulePreview();
    }

    /* -- review ------------------------------------------------------ */

    function renderRawTab(body) {
      body.appendChild(el('p', {
        class: 'egm-hint',
        style: 'margin:0 0 12px',
        text: 'This is exactly what will be written to ' + targetApp +
          '/local/eventgen.conf.'
      }));
      body.appendChild(el('textarea', {
        class: 'egm-textarea',
        rows: 22,
        readonly: true,
        spellcheck: 'false',
        value: buildConfText()
      }));
    }

    function buildConfText() {
      var payload = buildPayload();
      var lines = ['[' + (stanzaName || '<sample file>') + ']'];
      Object.keys(payload).sort(function (a, b) {
        var aToken = isTokenKey(a);
        var bToken = isTokenKey(b);
        if (aToken !== bToken) { return aToken ? 1 : -1; }
        return a.localeCompare(b, undefined, { numeric: true });
      }).forEach(function (key) {
        lines.push(key + ' = ' + payload[key]);
      });
      return lines.join('\n');
    }

    /* -- payload ----------------------------------------------------- */

    function buildPayload() {
      var payload = {};

      Object.keys(extras).forEach(function (key) {
        payload[key] = extras[key];
      });
      Object.keys(values).forEach(function (key) {
        if (values[key] === '' || values[key] === undefined) { return; }
        payload[key] = values[key];
      });

      /* Token indexes must run 0, 1, 2 with no gaps: eventgen stops
         reading at the first index it cannot find. */
      tokens.forEach(function (token, index) {
        if (!token.token) { return; }
        payload['token.' + index + '.token'] = token.token;
        payload['token.' + index + '.replacementType'] =
          token.replacementType || 'static';
        payload['token.' + index + '.replacement'] =
          token.replacement === undefined ? '' : token.replacement;
      });

      payload.disabled = isTrue(values.disabled) ? 'true' : 'false';
      return payload;
    }

    /* -- preview ----------------------------------------------------- */

    var schedulePreview = debounce(refreshPreview, 450);
    var testResultNode = null;
    var testCount = '10';

    /*
     * The preview never leaves this page. A test batch does: it generates a
     * few events with the real engine code and delivers them to the real
     * destination, so a wrong index, an HEC token, or a firewall shows up
     * now rather than after the configuration has been switched on.
     */
    function sendTestBatch(button) {
      var sample = previewSample.mode === 'file' ? previewSample.name : '';
      if (!sample) {
        toast('Choose a sample file to send test events from.', 'error');
        return;
      }
      button.disabled = true;
      button.textContent = 'Sending…';
      api.testBatch({
        app: targetApp,
        sample: sample,
        stanza: buildPayload(),
        count: Number(testCount)
      }).then(function (result) {
        var children = [
          el('p', {}, [
            el('strong', {
              text: 'Sent ' + number(result.sent) + ' event' +
                (result.sent === 1 ? '' : 's') + ' to ' + result.destination + '.'
            })
          ])
        ];
        if (result.search) {
          children.push(el('p', {}, [
            el('a', {
              href: ROOT + '/app/' + encodeURIComponent(APP) + '/search?q=' +
                encodeURIComponent(result.search),
              target: '_blank',
              rel: 'noopener',
              text: 'Search for them'
            }),
            ' — indexing usually takes a few seconds.'
          ]));
        }
        if (result.sample && result.sample.length) {
          children.push(el('pre', { text: result.sample.join('\n') }));
        }
        testResultNode = el('div', { class: 'egm-test-result' }, [
          note('info', el('div', { style: 'flex:1;min-width:0' }, children))
        ]);
        toast('Sent ' + result.sent + ' test events.', 'ok');
        refreshPreview();
      }).catch(function (error) {
        testResultNode = el('div', { class: 'egm-test-result' }, [
          note('error', el('div', {}, [
            el('p', { html: '<strong>The test batch was not delivered.</strong>' }),
            el('p', { text: error.message })
          ]))
        ]);
        toast(error.message, 'error');
        refreshPreview();
      });
    }

    function renderTestRow() {
      if (previewSample.mode !== 'file' || !previewSample.name) { return null; }
      var countSelect = el('select', {
        class: 'egm-select', style: 'width:auto',
        'aria-label': 'Number of test events',
        onchange: function (event) { testCount = event.target.value; }
      }, ['1', '10', '50', '100', '500'].map(function (value) {
        return el('option', { value: value, selected: value === testCount },
          [value]);
      }));
      var button = el('button', {
        class: 'egm-btn egm-btn-sm', type: 'button',
        text: 'Send test events',
        onclick: function (event) { sendTestBatch(event.target); }
      });
      return el('div', { class: 'egm-panel-body' }, [
        el('div', { style: 'display:flex;gap:8px;align-items:center' }, [
          el('span', { class: 'egm-hint', style: 'flex:1;margin:0',
            text: 'Generate events for real and deliver them to this ' +
              'configuration\u2019s destination, without turning it on.' }),
          countSelect,
          button
        ]),
        testResultNode
      ]);
    }

    function refreshPreview() {
      renderPreviewShell(spinner('Generating a preview…'));

      var payload = {
        app: targetApp,
        stanza: buildPayload(),
        limit: 12
      };

      if (previewSample.mode === 'text') {
        payload.content = previewSample.text;
      } else if (previewSample.name) {
        payload.sample = previewSample.name;
      } else {
        renderPreviewShell(el('div', { class: 'egm-term-empty' }, [
          'Choose a sample file to see generated events.'
        ]));
        return;
      }

      api.preview(payload).then(function (result) {
        renderPreviewResult(result);
      }).catch(function (error) {
        renderPreviewShell(el('div', { class: 'egm-term-empty' }, [
          error.message
        ]));
      });
    }

    function renderPreviewShell(bodyNode, footNode) {
      var picker = el('select', {
        class: 'egm-select',
        style: 'width:auto;max-width:220px',
        onchange: function (event) {
          testResultNode = null;
          if (event.target.value === '__paste__') {
            previewSample = { mode: 'text', name: '', text: '' };
          } else {
            previewSample = {
              mode: 'file', name: event.target.value, text: ''
            };
          }
          refreshPreview();
        }
      }, [el('option', { value: '' }, ['Choose a sample…'])]
        .concat(sampleFiles.map(function (file) {
          return el('option', {
            value: file.name,
            selected: previewSample.mode === 'file' &&
              previewSample.name === file.name
          }, [file.name]);
        }))
        .concat([
          el('option', {
            value: '__paste__',
            selected: previewSample.mode === 'text'
          }, ['Paste sample text…'])
        ]));

      var children = [
        el('div', { class: 'egm-panel-head' }, [
          el('h3', { text: 'Live preview' }),
          el('span', { class: 'egm-bar-spacer' }),
          picker,
          el('button', {
            class: 'egm-btn egm-btn-sm', type: 'button', text: 'Refresh',
            onclick: refreshPreview
          })
        ])
      ];

      if (previewSample.mode === 'text') {
        children.push(el('div', { class: 'egm-panel-body' }, [
          el('textarea', {
            class: 'egm-textarea',
            rows: 5,
            placeholder: 'Paste a few lines of sample data here.',
            value: previewSample.text,
            oninput: function (event) {
              previewSample.text = event.target.value;
              schedulePreview();
            }
          })
        ]));
      }

      children.push(el('div', { class: 'egm-panel-body egm-flush' }, [
        el('div', { class: 'egm-term' }, [
          el('div', { class: 'egm-term-head' }, [
            'Generated events',
            el('span', { class: 'egm-bar-spacer' }),
            el('span', { text: 'not indexed' })
          ]),
          el('div', { class: 'egm-term-body' }, [bodyNode]),
          footNode
        ])
      ]));

      children.push(renderTestRow());

      clear(previewHost).appendChild(el('div', { class: 'egm-panel' }, children));
    }

    function renderPreviewResult(result) {
      var lines = el('div', { class: 'egm-fade' });

      (result.events || []).forEach(function (event) {
        lines.appendChild(el('div', { class: 'egm-term-line' }, [
          el('span', { class: 'egm-term-no', text: String(event.index) }),
          el('span', { class: 'egm-term-raw' },
            (event.segments || [{ t: event.raw, g: false }]).map(
              function (segment) {
                return segment.g
                  ? el('span', { class: 'egm-sub', text: segment.t })
                  : document.createTextNode(segment.t);
              }))
        ]));
      });

      var settings = result.settings || {};
      var foot = el('div', { class: 'egm-term-foot' }, [
        el('span', {}, [
          el('b', { text: number(settings.eventsPerInterval || 0) }),
          ' per interval'
        ]),
        el('span', {}, [
          el('b', { text: String(settings.interval || 0) + 's' }),
          ' interval'
        ]),
        settings.eventsPerDay ? el('span', {}, [
          el('b', { text: number(settings.eventsPerDay) }),
          ' per day'
        ]) : null,
        el('span', {}, [
          el('b', { text: number(settings.replacements || 0) }),
          ' substitutions'
        ]),
        el('span', {}, [
          'to ',
          el('b', { text: settings.outputMode || 'modinput' })
        ])
      ]);

      renderPreviewShell(
        (result.events || []).length
          ? lines
          : el('div', { class: 'egm-term-empty' },
            ['Nothing was generated from this sample.']),
        foot
      );

      if (result.warnings && result.warnings.length) {
        previewHost.appendChild(el('div', { style: 'margin-top:12px' }, [
          note('warn', el('div', {}, [
            el('p', { html: '<strong>Worth checking</strong>' }),
            el('ul', {}, result.warnings.map(function (warning) {
              return el('li', { text: warning });
            }))
          ]))
        ]));
      }
    }

    /* -- save -------------------------------------------------------- */

    function save() {
      validationErrors = {};

      if (!stanzaName) {
        validationErrors.name = 'Give the configuration a sample file name.';
        activeTab = 'identity';
        renderForm();
        toast('The configuration needs a sample file name.', 'error');
        return;
      }

      var badJson = ['hourOfDayRate', 'dayOfWeekRate', 'minuteOfHourRate',
        'dayOfMonthRate', 'monthOfYearRate', 'jinja_variables',
        'httpeventServers'].filter(function (key) {
          return values[key] && !validateJson(key, values[key]);
        });

      if (badJson.length) {
        renderForm();
        toast('Fix the JSON in ' + badJson.join(', ') + ' before saving.',
          'error');
        return;
      }

      var emptyToken = tokens.filter(function (token) {
        return !token.token;
      }).length;

      if (emptyToken) {
        activeTab = 'tokens';
        renderForm();
        toast(emptyToken + ' token' + (emptyToken > 1 ? 's have' : ' has') +
          ' no pattern. Fill it in or remove it.', 'error');
        return;
      }

      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';

      conf.save(targetApp, stanzaName, buildPayload(), originalValues, isNew,
        options.stanza ? options.stanza.removable : undefined)
        .then(function (result) {
          var kept = (result || {}).keptKeys;
          if (kept && kept.length) {
            toast('Saved ' + stanzaName + ', but ' + kept.join(', ') +
              ' could not be cleared because this configuration ships with ' +
              'the app. Clone it to get a copy you fully control.', 'warn');
          } else {
            toast(isNew
              ? 'Created ' + stanzaName + '.'
              : 'Saved ' + stanzaName + '.', 'ok');
          }
          close();
          if (options.onSaved) { options.onSaved(); }
        })
        .catch(function (error) {
          saveButton.disabled = false;
          saveButton.textContent = isNew
            ? 'Create configuration' : 'Save changes';
          toast(error.message, 'error');
        });
    }

    renderForm();
    renderPreviewShell(el('div', { class: 'egm-term-empty' },
      ['Choose a sample file to see generated events.']));
  }

  function collectTokens(content) {
    var byIndex = {};

    Object.keys(content).forEach(function (key) {
      var match = /^token\.(\d+)\.(token|replacementType|replacement)$/
        .exec(key);
      if (!match) { return; }
      var index = Number(match[1]);
      byIndex[index] = byIndex[index] || {};
      byIndex[index][match[2]] = String(content[key]);
    });

    return Object.keys(byIndex)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .map(function (index) {
        var entry = byIndex[index];
        return {
          token: entry.token || '',
          replacementType: entry.replacementType || 'static',
          replacement: entry.replacement || ''
        };
      })
      .filter(function (token) { return token.token !== ''; });
  }
  /* ==================================================================== */
  /* Page: Configurations                                                 */
  /* ==================================================================== */

  function renderConfigsPage(mount) {
    var state = {
      stanzas: [], filter: '', health: null, status: null, loading: true
    };

    function engineState() {
      return state.health && state.health.engine
        ? state.health.engine.state : null;
    }

    // A stanza being enabled is only half the story. Nothing is produced
    // unless the engine is also running, and calling a stanza "Generating"
    // while it is not sends people looking for data that will never arrive.
    function generatorRunning() {
      return engineState() === 'running';
    }

    function reloadSeconds() {
      var engineInfo = (state.health && state.health.engine) || {};
      return Number(engineInfo.reloadInterval ||
        (engineInfo.input || {}).reloadInterval || 10);
    }

    function statusPill(item, enabled) {
      if (!enabled) { return pill('Paused', 'off'); }
      if (!generatorRunning()) {
        return pill(engineState() === 'standby' ? 'Standby' : 'Idle', 'warn');
      }
      var live = liveFor(state.status, item);
      if (!live) { return pill('Starting', 'warn'); }
      if (live.state === 'error') { return pill('Error', 'bad'); }
      if (live.state === 'finished') { return pill('Finished', 'off'); }
      if (live.state === 'backfilling') { return pill('Backfilling', 'on'); }
      if (live.state === 'starting') { return pill('Starting', 'warn'); }
      return pill('Generating', 'on');
    }

    /*
     * The engine notices configuration changes by itself, so a change needs
     * no restart: it applies at the engine's next check, a few seconds away.
     */
    function applied(message) {
      if (message) {
        toast(message + (generatorRunning()
          ? ' The engine picks it up within ' + reloadSeconds() + 's.'
          : ''), 'ok');
      }
      load();
      setTimeout(refreshStatus, (reloadSeconds() + 1) * 1000);
    }

    function reapply() { applied(null); }

    var banner = el('div');
    var stats = el('div');
    var tableHost = el('div');

    var searchBox = el('input', {
      class: 'egm-input',
      type: 'search',
      placeholder: 'Filter by sample, app, or sourcetype',
      style: 'width:260px',
      oninput: function (event) {
        state.filter = event.target.value.toLowerCase();
        renderTable();
      }
    });

    clear(mount).appendChild(el('div', {}, [
      el('div', { class: 'egm-bar' }, [
        el('span', {
          class: 'egm-eyebrow',
          text: 'Every app on this instance'
        }),
        el('span', { class: 'egm-bar-spacer' }),
        searchBox,
        el('button', {
          class: 'egm-btn', text: 'Refresh', onclick: load
        }),
        el('button', {
          class: 'egm-btn egm-btn-primary',
          text: 'New configuration',
          onclick: function () {
            openEditor({ isNew: true, onSaved: reapply });
          }
        })
      ]),
      banner,
      stats,
      tableHost
    ]));

    load();

    /* Counters change every interval; poll them while the page is open,
       and stop as soon as it is not. */
    var poller = setInterval(function () {
      if (!document.body.contains(mount)) {
        clearInterval(poller);
        return;
      }
      if (document.hidden) { return; }
      refreshStatus();
    }, 5000);

    function refreshStatus() {
      api.status().then(function (status) {
        state.status = status;
        if (!state.loading) {
          renderStats();
          renderTable();
        }
      }).catch(function () { /* keep the last good figures */ });
    }

    function load() {
      state.loading = true;
      clear(tableHost).appendChild(spinner('Reading eventgen.conf…'));

      Promise.all([
        conf.list(),
        api.health().catch(function () { return null; }),
        api.status().catch(function () { return null; })
      ]).then(function (results) {
        state.stanzas = results[0];
        state.health = results[1];
        state.status = results[2];
        state.loading = false;
        renderBanner();
        renderStats();
        renderTable();
      }).catch(function (error) {
        state.loading = false;
        failure(tableHost, error);
      });
    }

    function renderBanner() {
      clear(banner);
      if (!state.health) { return; }

      var engineChecks = ['engine_enabled', 'engine_running',
        'samples_writable'];
      var failing = (state.health.checks || []).filter(function (check) {
        return !check.ok && engineChecks.indexOf(check.id) !== -1;
      });
      if (!failing.length) { return; }

      var input = (state.health.engine || {}).input || {};
      var sa = state.health.saEventgen || {};
      var action = null;

      // Only offer a button that can work. One that fails is worse than
      // none at all.
      if (input.available && !input.enabled) {
        action = el('button', {
          class: 'egm-btn egm-btn-sm egm-btn-primary',
          text: 'Turn on the engine',
          onclick: function (event) {
            var button = event.target;
            button.disabled = true;
            button.textContent = 'Starting…';
            engine.setEnabled(input.name || 'default', true).then(function () {
              toast('The engine is on. Events start within a few seconds.',
                'ok');
              setTimeout(load, 4000);
            }).catch(function (error) {
              button.disabled = false;
              button.textContent = 'Turn on the engine';
              toast(error.message, 'error');
            });
          }
        });
      } else if (engineState() === 'standby' && sa.enabled) {
        action = el('button', {
          class: 'egm-btn egm-btn-sm egm-btn-primary',
          text: 'Switch to the built-in engine',
          onclick: function (event) {
            var button = event.target;
            button.disabled = true;
            button.textContent = 'Switching…';
            saEventgen.disableAll(sa.inputs).then(function () {
              toast('SA-Eventgen is off. The built-in engine takes over ' +
                'within ' + reloadSeconds() + 's.', 'ok');
              setTimeout(load, (reloadSeconds() + 1) * 1000);
            }).catch(function (error) {
              button.disabled = false;
              button.textContent = 'Switch to the built-in engine';
              toast(error.message, 'error');
            });
          }
        });
      }

      banner.appendChild(note('warn', el('div', { style: 'flex:1' }, [
        el('p', {
          html: '<strong>Nothing is being generated right now.</strong>'
        }),
        el('ul', {}, failing.map(function (check) {
          return el('li', { text: check.label + ' — ' + check.detail });
        })),
        action ? el('div', { style: 'margin-top:8px' }, [action]) : null
      ])));
    }

    function renderStats() {
      var total = state.stanzas.length;
      var on = state.stanzas.filter(function (item) {
        return !isTrue(item.content.disabled);
      }).length;
      var apps = {};
      state.stanzas.forEach(function (item) { apps[item.app] = true; });

      var generated = 0;
      var errors = 0;
      var stanzasLive = (state.status && state.status.stanzas) || {};
      Object.keys(stanzasLive).forEach(function (key) {
        generated += Number(stanzasLive[key].events || 0);
        if (stanzasLive[key].state === 'error') { errors += 1; }
      });

      clear(stats).appendChild(el('div', { class: 'egm-stats' }, [
        el('div', { class: 'egm-stat' }, [
          el('b', { text: number(total) }),
          el('span', { text: 'configurations' })
        ]),
        el('div', { class: 'egm-stat' }, [
          el('b', { text: number(on) }),
          el('span', {
            text: generatorRunning() ? 'generating' : 'enabled, none running'
          })
        ]),
        el('div', { class: 'egm-stat' }, [
          el('b', { text: number(generated) }),
          el('span', { text: 'events since the engine started' })
        ]),
        errors ? el('div', { class: 'egm-stat' }, [
          el('b', { text: number(errors), style: 'color:var(--egm-error)' }),
          el('span', { text: 'failing' })
        ]) : el('div', { class: 'egm-stat' }, [
          el('b', { text: number(Object.keys(apps).length) }),
          el('span', { text: 'apps' })
        ])
      ]));
    }

    function visible() {
      if (!state.filter) { return state.stanzas; }
      return state.stanzas.filter(function (item) {
        return (item.name + ' ' + item.app + ' ' +
          (item.content.sourcetype || '') + ' ' +
          (item.content.index || '')).toLowerCase()
          .indexOf(state.filter) !== -1;
      });
    }

    function renderTable() {
      var rows = visible();
      clear(tableHost);

      if (!state.stanzas.length) {
        tableHost.appendChild(panel('Configurations', [
          emptyState(
            'No configurations yet',
            'A configuration ties a sample file to a schedule and a set of ' +
              'token replacements. Create one to start generating events.',
            el('button', {
              class: 'egm-btn egm-btn-primary',
              text: 'New configuration',
              onclick: function () {
                openEditor({ isNew: true, onSaved: reapply });
              }
            }))
        ], null, true));
        return;
      }

      if (!rows.length) {
        tableHost.appendChild(panel('Configurations', [
          emptyState('Nothing matches that filter',
            'Try a different sample name, app, or sourcetype.')
        ], null, true));
        return;
      }

      var body = el('tbody', {}, rows.map(renderRow));

      tableHost.appendChild(panel(
        'Configurations',
        [el('table', { class: 'egm-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: 'Sample' }),
            el('th', { text: 'Status' }),
            el('th', { text: 'Mode' }),
            el('th', { text: 'Every' }),
            el('th', { text: 'Events' }),
            el('th', { text: 'Generated' }),
            el('th', { text: 'Destination' }),
            el('th', {})
          ])),
          body
        ])],
        null,
        true
      ));
    }

    function renderLive(item, enabled) {
      var live = enabled ? liveFor(state.status, item) : null;
      if (!live) { return el('td', { class: 'egm-name-sub', text: '—' }); }
      return el('td', {}, [
        el('div', { text: number(live.events) }),
        el('div', {
          class: 'egm-live',
          text: live.lastBatchAt ? 'last batch ' + ago(live.lastBatchAt)
            : (live.files > 1 ? live.files + ' files' : 'no batch yet')
        })
      ]);
    }

    function renderRow(item) {
      var content = item.content;
      var enabled = !isTrue(content.disabled);
      var count = content.perDayVolume
        ? content.perDayVolume + ' GB/day'
        : (content.count && String(content.count) !== '0'
          ? number(content.count)
          : 'whole file');

      var destination = content.outputMode || 'modinput';
      var destinationDetail = ['modinput', 'splunkstream', 'httpevent']
        .indexOf(destination) !== -1
        ? (content.index || 'main') + ' / ' + (content.sourcetype || 'eventgen')
        : '';

      var live = enabled ? liveFor(state.status, item) : null;
      var actions = el('td', { class: 'egm-actions' });

      if (item.canWrite) {
        actions.appendChild(el('button', {
          class: 'egm-btn egm-btn-sm',
          text: enabled ? 'Pause' : 'Start',
          onclick: function (event) { toggle(item, enabled, event.target); }
        }));
        actions.appendChild(el('button', {
          class: 'egm-btn egm-btn-sm', text: 'Edit',
          onclick: function () {
            openEditor({ stanza: item, onSaved: reapply });
          }
        }));
      }

      actions.appendChild(el('button', {
        class: 'egm-btn egm-btn-sm', text: 'Clone',
        onclick: function () { clone(item); }
      }));

      if (item.canWrite && item.removable) {
        actions.appendChild(el('button', {
          class: 'egm-btn egm-btn-sm egm-btn-danger', text: 'Delete',
          onclick: function () { remove(item); }
        }));
      }

      return el('tr', {}, [
        el('td', {}, [
          el('div', { class: 'egm-name egm-mono', text: item.name }),
          el('div', { class: 'egm-name-sub', text: item.app })
        ]),
        el('td', {}, [
          statusPill(item, enabled),
          item.canWrite ? null
            : el('div', { class: 'egm-live', text: 'Read only — clone to edit' }),
          live && live.lastError && generatorRunning()
            ? el('div', { class: 'egm-live-error', text: live.lastError })
            : null
        ]),
        el('td', { text: content.mode || 'sample' }),
        el('td', { text: (content.interval || '60') + 's' }),
        el('td', { text: count }),
        renderLive(item, enabled),
        el('td', {}, [
          el('div', { text: destination }),
          destinationDetail
            ? el('div', { class: 'egm-name-sub', text: destinationDetail })
            : null
        ]),
        actions
      ]);
    }

    function toggle(item, enabled, button) {
      button.disabled = true;
      conf.update(item.app, item.name, { disabled: enabled ? 'true' : 'false' })
        .then(function () {
          applied(enabled
            ? 'Paused ' + item.name + '.'
            : 'Started ' + item.name + '.');
        })
        .catch(function (error) {
          button.disabled = false;
          toast(error.message, 'error');
        });
    }

    function clone(item) {
      var copy = {
        name: '',
        app: APP,
        content: JSON.parse(JSON.stringify(item.content))
      };
      copy.content.disabled = 'true';
      openEditor({ stanza: copy, isNew: true, onSaved: reapply });
    }

    function remove(item) {
      confirmDialog(
        'Delete the configuration for ' + item.name + ' in ' + item.app +
        '? The sample file itself is not touched.',
        'Delete configuration'
      ).then(function (confirmed) {
        if (!confirmed) { return; }
        conf.remove(item.app, item.name).then(function () {
          applied('Deleted ' + item.name + '.');
        }).catch(function (error) {
          toast(error.message, 'error');
        });
      });
    }
  }

  /* ==================================================================== */
  /* Page: Sample data                                                    */
  /* ==================================================================== */

  function renderSamplesPage(mount) {
    var state = { app: APP, apps: [], files: [], dir: '' };

    var appPicker = el('select', {
      class: 'egm-select',
      id: 'egm-app-picker',
      style: 'width:auto',
      onchange: function (event) {
        state.app = event.target.value;
        loadFiles();
      }
    });

    var pathNote = el('div');
    var tableHost = el('div');
    var fileInput = el('input', {
      type: 'file',
      class: 'egm-sr',
      accept: '.sample,.csv,.log,.txt,.json,.list,.tsv',
      onchange: function (event) {
        var file = event.target.files && event.target.files[0];
        if (file) { upload(file); }
        event.target.value = '';
      }
    });

    clear(mount).appendChild(el('div', {}, [
      el('div', { class: 'egm-bar' }, [
        el('label', {
          class: 'egm-eyebrow', for: 'egm-app-picker', text: 'App'
        }),
        appPicker,
        el('span', { class: 'egm-bar-spacer' }),
        el('button', {
          class: 'egm-btn', text: 'Upload a file',
          onclick: function () { fileInput.click(); }
        }),
        el('button', {
          class: 'egm-btn egm-btn-primary', text: 'New sample file',
          onclick: function () { openSampleEditor(null); }
        })
      ]),
      fileInput,
      pathNote,
      tableHost
    ]));

    api.apps().then(function (data) {
      state.apps = (data.apps || []).filter(function (item) {
        return item.writable;
      });
      clear(appPicker);
      state.apps.forEach(function (item) {
        appPicker.appendChild(el('option', {
          value: item.name, selected: item.name === state.app
        }, [item.label === item.name ? item.name
          : item.label + ' (' + item.name + ')']));
      });
      loadFiles();
    }).catch(function (error) {
      failure(tableHost, error);
    });

    function loadFiles() {
      clear(tableHost).appendChild(spinner('Reading the samples folder…'));

      api.samples(state.app).then(function (data) {
        state.files = data.files || [];
        state.dir = data.dir;

        clear(pathNote).appendChild(note('info', el('div', {}, [
          el('p', {
            text: 'Eventgen reads sample files from this folder:'
          }),
          el('p', { class: 'egm-mono', text: data.dir, style: 'margin-top:2px' })
        ])));

        renderTable();
      }).catch(function (error) {
        failure(tableHost, error);
      });
    }

    function renderTable() {
      clear(tableHost);

      if (!state.files.length) {
        tableHost.appendChild(panel('Sample files', [
          emptyState(
            'No sample files in ' + state.app,
            'A sample file holds the raw events to generate from — one event ' +
              'per line for most formats. Upload one, or write a few lines ' +
              'here to get going.',
            el('button', {
              class: 'egm-btn egm-btn-primary', text: 'New sample file',
              onclick: function () { openSampleEditor(null); }
            }))
        ], null, true));
        return;
      }

      tableHost.appendChild(panel('Sample files', [
        el('table', { class: 'egm-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: 'File' }),
            el('th', { text: 'Lines' }),
            el('th', { text: 'Size' }),
            el('th', { text: 'Changed' }),
            el('th', {})
          ])),
          el('tbody', {}, state.files.map(function (file) {
            return el('tr', {}, [
              el('td', { class: 'egm-mono egm-name', text: file.name }),
              el('td', { text: number(file.lines) }),
              el('td', { text: bytes(file.bytes) }),
              el('td', { text: ago(file.modified) }),
              el('td', { class: 'egm-actions' }, [
                el('button', {
                  class: 'egm-btn egm-btn-sm', text: 'Open',
                  onclick: function () { openSampleEditor(file.name); }
                }),
                el('button', {
                  class: 'egm-btn egm-btn-sm', text: 'Use in a configuration',
                  onclick: function () {
                    openEditor({
                      isNew: true,
                      stanza: { name: file.name, app: state.app, content: {} },
                      onSaved: function () {
                        toast('Configuration created for ' + file.name + '.',
                          'ok');
                      }
                    });
                  }
                }),
                el('button', {
                  class: 'egm-btn egm-btn-sm egm-btn-danger', text: 'Delete',
                  onclick: function () { removeFile(file.name); }
                })
              ])
            ]);
          }))
        ])
      ], null, true));
    }

    function upload(file) {
      if (file.size > 5 * 1024 * 1024) {
        toast('That file is larger than 5 MB. Trim it, or copy it to the ' +
          'samples folder on the server.', 'error');
        return;
      }

      var reader = new FileReader();
      reader.onload = function () {
        api.writeSample({
          app: state.app,
          name: file.name,
          content: String(reader.result),
          overwrite: false
        }).then(function () {
          toast('Uploaded ' + file.name + '.', 'ok');
          loadFiles();
        }).catch(function (error) {
          toast(error.message, 'error');
        });
      };
      reader.onerror = function () {
        toast('That file could not be read.', 'error');
      };
      reader.readAsText(file);
    }

    function removeFile(name) {
      confirmDialog(
        'Delete ' + name + ' from ' + state.app + '? Any configuration that ' +
        'uses it will stop producing events.',
        'Delete file'
      ).then(function (confirmed) {
        if (!confirmed) { return; }
        api.deleteSample(state.app, name).then(function () {
          toast('Deleted ' + name + '.', 'ok');
          loadFiles();
        }).catch(function (error) {
          toast(error.message, 'error');
        });
      });
    }

    /* -- sample file editor ------------------------------------------ */

    function openSampleEditor(name) {
      var isNew = !name;
      var scrim = el('div', { class: 'egm-scrim' });
      var area = el('textarea', {
        class: 'egm-textarea',
        rows: 20,
        spellcheck: 'false',
        placeholder: 'One event per line.'
      });

      var nameInput = el('input', {
        class: 'egm-input',
        type: 'text',
        value: name || '',
        disabled: !isNew,
        placeholder: 'access_combined.sample',
        style: 'width:280px'
      });

      var meta = el('span', { class: 'egm-hint' });

      var saveButton = el('button', {
        class: 'egm-btn egm-btn-primary',
        text: isNew ? 'Create file' : 'Save file',
        onclick: submit
      });

      var drawer = el('div', {
        class: 'egm-drawer egm',
        role: 'dialog',
        'aria-modal': 'true',
        style: 'width:min(940px,94vw)'
      }, [
        el('div', { class: 'egm-drawer-head' }, [
          el('h2', { text: isNew ? 'New sample file' : name }),
          el('span', { class: 'egm-bar-spacer' }),
          el('button', {
            class: 'egm-close', 'aria-label': 'Close', text: '\u00d7',
            onclick: close
          })
        ]),
        el('div', { class: 'egm-drawer-body' }, [
          el('div', { class: 'egm-field' }, [
            el('label', { class: 'egm-label', text: 'File name' }),
            nameInput,
            el('p', {
              class: 'egm-hint',
              text: 'Letters, numbers, dots, dashes, and underscores. ' +
                'The configuration stanza refers to this name.'
            })
          ]),
          el('div', { class: 'egm-field' }, [
            el('label', { class: 'egm-label', text: 'Contents' }),
            area,
            meta
          ])
        ]),
        el('div', { class: 'egm-drawer-foot' }, [
          el('span', { class: 'egm-bar-spacer' }),
          el('button', { class: 'egm-btn', text: 'Cancel', onclick: close }),
          saveButton
        ])
      ]);

      function close() {
        document.removeEventListener('keydown', onKey);
        scrim.remove();
        drawer.remove();
      }

      function onKey(event) {
        if (event.key === 'Escape') { close(); }
      }

      scrim.addEventListener('click', close);
      document.addEventListener('keydown', onKey);
      document.body.appendChild(scrim);
      document.body.appendChild(drawer);

      if (!isNew) {
        area.value = 'Loading…';
        area.disabled = true;
        api.readSample(state.app, name, 500).then(function (data) {
          area.value = data.content;
          area.disabled = false;
          if (data.truncated) {
            meta.textContent = 'Showing the first ' + data.lines +
              ' lines of ' + name + '. Saving would replace the rest of the ' +
              'file, so editing is limited to viewing here.';
            area.readOnly = true;
            saveButton.disabled = true;
          } else {
            meta.textContent = data.lines + ' lines.';
          }
        }).catch(function (error) {
          area.value = '';
          area.disabled = false;
          toast(error.message, 'error');
        });
      }

      function submit() {
        var fileName = nameInput.value.trim();
        if (!fileName) {
          toast('Give the file a name.', 'error');
          nameInput.focus();
          return;
        }

        saveButton.disabled = true;
        saveButton.textContent = 'Saving…';

        api.writeSample({
          app: state.app,
          name: fileName,
          content: area.value,
          overwrite: !isNew
        }).then(function () {
          toast('Saved ' + fileName + '.', 'ok');
          close();
          loadFiles();
        }).catch(function (error) {
          saveButton.disabled = false;
          saveButton.textContent = isNew ? 'Create file' : 'Save file';
          toast(error.message, 'error');
        });
      }
    }
  }

  /* ==================================================================== */
  /* Page: Generator control                                              */
  /* ==================================================================== */

  function renderControlPage(mount) {
    var checksHost = el('div');
    var controlHost = el('div');

    clear(mount).appendChild(el('div', {}, [
      el('div', { class: 'egm-bar' }, [
        el('span', {
          class: 'egm-eyebrow',
          text: 'Built-in generation engine'
        }),
        el('span', { class: 'egm-bar-spacer' }),
        el('button', { class: 'egm-btn', text: 'Re-check', onclick: load })
      ]),
      el('div', { class: 'egm-split' }, [checksHost, controlHost])
    ]));

    load();

    function load() {
      clear(checksHost).appendChild(spinner('Checking…'));
      clear(controlHost);

      api.health().then(function (health) {
        renderChecks(health);
        renderControls(health);
      }).catch(function (error) {
        failure(checksHost, error);
      });
    }

    function renderChecks(health) {
      var list = el('ul', { class: 'egm-checks' },
        (health.checks || []).map(function (check) {
          return el('li', {}, [
            el('span', {
              class: 'egm-check-icon ' + (check.ok ? 'ok' : 'bad'),
              'aria-hidden': 'true',
              text: check.ok ? '✓' : '!'
            }),
            el('span', { class: 'egm-check-text' }, [
              el('strong', { text: check.label }),
              el('span', { text: check.detail })
            ])
          ]);
        }));

      clear(checksHost).appendChild(panel(
        'Status',
        [list],
        [health.ok
          ? pill('Ready', 'on')
          : pill('Needs attention', 'warn')]
      ));
    }

    function statePill(stateName) {
      if (stateName === 'running') { return pill('Running', 'on'); }
      if (stateName === 'standby') { return pill('Standby', 'warn'); }
      if (stateName === 'stopped') { return pill('Stopped', 'off'); }
      return pill('Not reporting', 'warn');
    }

    function renderControls(health) {
      var engineInfo = health.engine || {};
      var input = engineInfo.input || {};
      clear(controlHost);

      if (!input.available) {
        controlHost.appendChild(panel('Engine', [
          note('warn', el('div', {}, [
            el('p', {
              html: input.reason === 'forbidden'
                ? '<strong>Not permitted to read the engine input.</strong>'
                : '<strong>The engine input is missing.</strong>'
            }),
            el('p', {
              text: input.reason === 'forbidden'
                ? 'Controlling the engine needs the admin or sc_admin role.'
                : 'Eventgen Manager ships an [eventgen_manager_engine://' +
                  'default] input. Restart Splunk; if it is still missing, ' +
                  'reinstall the app.'
            })
          ]))
        ]));
        renderSaEventgen(health);
        return;
      }

      var levelSelect = el('select', { class: 'egm-select' },
        [['DEBUG', 'Debug — every decision'], ['INFO', 'Info'],
         ['WARNING', 'Warning'], ['ERROR', 'Error — quietest']]
          .map(function (option) {
            return el('option', {
              value: option[0],
              selected: String(input.logLevel || 'INFO').toUpperCase() ===
                option[0]
            }, [option[1]]);
          }));
      var reloadInput = el('input', {
        class: 'egm-input', type: 'number', min: '2',
        value: input.reloadInterval || '10'
      });

      var toggleButton = el('button', {
        class: 'egm-btn ' + (input.enabled ? '' : 'egm-btn-primary'),
        text: input.enabled ? 'Stop the engine' : 'Start the engine',
        onclick: function () {
          toggleButton.disabled = true;
          toggleButton.textContent = input.enabled ? 'Stopping…' : 'Starting…';
          engine.setEnabled(input.name, !input.enabled).then(function () {
            toast(input.enabled
              ? 'The engine is stopped. Nothing is generated until it is ' +
                'started again.'
              : 'The engine is starting. Events follow within seconds.',
              'ok');
            setTimeout(load, input.enabled ? 500 : 4000);
          }).catch(function (error) {
            toggleButton.disabled = false;
            toast(error.message, 'error');
          });
        }
      });

      var saveButton = el('button', {
        class: 'egm-btn egm-btn-primary',
        text: 'Save settings',
        onclick: function () {
          var seconds = Number(reloadInput.value);
          if (!(seconds >= 2)) {
            toast('The reload interval must be at least 2 seconds.', 'error');
            return;
          }
          saveButton.disabled = true;
          saveButton.textContent = 'Saving…';
          engine.update(input.name, {
            log_level: levelSelect.value,
            reload_interval: String(Math.round(seconds))
          }).then(function () {
            toast('Saved. Splunk restarts the engine to apply it.', 'ok');
            setTimeout(load, 3000);
          }).catch(function (error) {
            saveButton.disabled = false;
            saveButton.textContent = 'Save settings';
            toast(error.message, 'error');
          });
        }
      });

      var facts = [
        ['Version', engineInfo.version || '—'],
        ['Platform', health.platform || '—'],
        ['Process', engineInfo.pid ? String(engineInfo.pid) : '—'],
        ['Started', engineInfo.startedAt ? ago(engineInfo.startedAt) : '—'],
        ['Last report', engineInfo.reportAge === null ||
          engineInfo.reportAge === undefined
          ? '—' : engineInfo.reportAge + 's ago']
      ];

      controlHost.appendChild(panel(
        'Engine',
        [
          el('p', {
            class: 'egm-hint',
            style: 'margin:0 0 14px',
            text: 'One engine runs every configuration on this instance. It ' +
              'is part of this app — SA-Eventgen is not needed — and runs ' +
              'on any platform Splunk supports.'
          }),
          el('dl', { class: 'egm-kv' }, facts.reduce(function (all, fact) {
            return all.concat([el('dt', { text: fact[0] }),
              el('dd', { text: fact[1] })]);
          }, [])),
          engineInfo.lastReloadError ? note('error', el('div', {}, [
            el('p', { html: '<strong>The last configuration read failed.</strong>' }),
            el('p', { text: engineInfo.lastReloadError })
          ])) : null,
          el('div', { class: 'egm-row' }, [
            el('div', { class: 'egm-field' }, [
              el('label', { class: 'egm-label', text: 'Log detail' }),
              levelSelect,
              el('p', {
                class: 'egm-hint',
                text: 'Written to eventgen_manager_engine.log in _internal.'
              })
            ]),
            el('div', { class: 'egm-field' }, [
              el('label', { class: 'egm-label',
                text: 'Check for changes every (seconds)' }),
              reloadInput,
              el('p', {
                class: 'egm-hint',
                text: 'How quickly a started, paused, or edited ' +
                  'configuration takes effect.'
              })
            ])
          ]),
          el('div', { style: 'display:flex;gap:8px' }, [
            saveButton, toggleButton
          ])
        ],
        [input.enabled ? statePill(engineInfo.state) : pill('Stopped', 'off')]
      ));

      renderSaEventgen(health);
    }

    function renderSaEventgen(health) {
      var sa = health.saEventgen || {};
      if (!sa.installed) { return; }

      var body;
      if (sa.enabled) {
        var switchButton = el('button', {
          class: 'egm-btn egm-btn-primary',
          text: 'Switch to the built-in engine',
          onclick: function () {
            switchButton.disabled = true;
            switchButton.textContent = 'Switching…';
            saEventgen.disableAll(sa.inputs).then(function () {
              toast('SA-Eventgen is off. The built-in engine takes over ' +
                'within seconds.', 'ok');
              setTimeout(load, 5000);
            }).catch(function (error) {
              switchButton.disabled = false;
              switchButton.textContent = 'Switch to the built-in engine';
              toast(error.message, 'error');
            });
          }
        });
        body = [
          note('warn', el('div', {}, [
            el('p', { html: '<strong>SA-Eventgen is still generating.</strong>' }),
            el('p', {
              text: 'It reads the same eventgen.conf as the built-in ' +
                'engine, so the engine waits on standby rather than produce ' +
                'every event twice. Switching turns SA-Eventgen’s input ' +
                'off; your configurations carry on unchanged under the ' +
                'built-in engine.'
            })
          ])),
          el('div', { style: 'margin-top:12px' }, [switchButton])
        ];
      } else {
        body = [el('p', {
          class: 'egm-hint', style: 'margin:0',
          text: 'SA-Eventgen is installed but not generating. Eventgen ' +
            'Manager no longer needs it, so it can be uninstalled whenever ' +
            'nothing else on this instance depends on it.'
        })];
      }

      controlHost.appendChild(el('div', { style: 'margin-top:16px' }, [
        panel('SA-Eventgen', body,
          [sa.enabled ? pill('Running', 'warn') : pill('Not needed', 'off')])
      ]));
    }
  }

  /* ==================================================================== */
  /* Page dispatch                                                        */
  /* ==================================================================== */

  var mount = document.getElementById('egm-root');
  if (!mount) { return; }
  mount.classList.add('egm', 'egm-page');

  /* The dashboard wraps our container in a panel. These pages draw their own
     panels, so the outer one is flattened to avoid a box inside a box. */
  var host = mount.closest ? mount.closest('.dashboard-panel') : null;
  if (host) { host.classList.add('egm-host'); }

  var pages = {
    eventgen_configs: renderConfigsPage,
    eventgen_samples: renderSamplesPage,
    eventgen_control: renderControlPage
  };

  var renderPage = pages[page.page];

  if (typeof renderPage === 'function') {
    try {
      renderPage(mount);
    } catch (error) {
      failure(mount, error);
    }
  } else {
    clear(mount).appendChild(emptyState(
      'This page has nothing to show',
      'No view is registered for "' + page.page + '".'));
  }
});
