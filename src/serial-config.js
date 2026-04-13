import $ from 'jquery';

const STORAGE_KEY = 'serial-channel-bindings';
const SETTINGS_KEY = 'serial-config-settings';
const CHANNEL_COUNT = 16;
const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_TRIGGER_COOLDOWN_MS = 1000;
const DEFAULT_SUSTAIN_REPEATS = 3;
const DEFAULT_BINDINGS = [
  'Q', 'W', 'E', 'R',
  'T', 'Y', 'U', 'I',
  'O', 'P', 'A', 'S',
  'D', 'F', 'G', 'H'
];

const KEY_OPTIONS = [
  '',
  'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P',
  'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L',
  'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'SPACE'
];

function isStorageAvailable() {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch (_error) {
    return false;
  }
}

function loadStoredState() {
  const defaults = {
    bindings: DEFAULT_BINDINGS.slice(),
    baudRate: DEFAULT_BAUD_RATE,
    triggerCooldownMs: DEFAULT_TRIGGER_COOLDOWN_MS,
    sustainRepeats: DEFAULT_SUSTAIN_REPEATS,
    autoReconnect: false,
  };

  if (!isStorageAvailable()) {
    return defaults;
  }

  try {
    const storedSettings = window.localStorage.getItem(SETTINGS_KEY);
    if (storedSettings) {
      const parsed = JSON.parse(storedSettings);
      return {
        bindings: normalizeBindings(parsed.bindings),
        baudRate: Number.parseInt(parsed.baudRate, 10) || defaults.baudRate,
        triggerCooldownMs:
          Number.parseInt(parsed.triggerCooldownMs, 10) || defaults.triggerCooldownMs,
        sustainRepeats: normalizeSustainRepeats(
          parsed.sustainRepeats ?? parsed.chargeFactor
        ),
        autoReconnect: typeof parsed.autoReconnect === 'boolean'
          ? parsed.autoReconnect
          : defaults.autoReconnect,
      };
    }

    const legacyBindings = window.localStorage.getItem(STORAGE_KEY);
    if (legacyBindings) {
      return {
        ...defaults,
        bindings: normalizeBindings(JSON.parse(legacyBindings)),
      };
    }
  } catch (_error) {
    return defaults;
  }

  return defaults;
}

function saveStoredState(settings) {
  if (!isStorageAvailable()) {
    return;
  }

  const snapshot = {
    bindings: normalizeBindings(settings.bindings),
    baudRate: settings.baudRate,
    triggerCooldownMs: settings.triggerCooldownMs,
      sustainRepeats: settings.sustainRepeats,
    autoReconnect: settings.autoReconnect,
  };

  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.bindings));
}

function normalizeKeyLabel(value) {
  if (!value) {
    return '';
  }

  const label = String(value).trim().toUpperCase();
  if (label === 'SPACE' || label === 'SPACEBAR') {
    return 'SPACE';
  }

  return /^[A-Z]$/.test(label) ? label : '';
}

function normalizeSustainRepeats(value) {
  const repeats = Number.parseInt(value, 10);
  if (Number.isNaN(repeats) || repeats < 0) {
    return DEFAULT_SUSTAIN_REPEATS;
  }

  return repeats;
}

function normalizeBindings(bindings) {
  const result = DEFAULT_BINDINGS.slice();

  if (Array.isArray(bindings)) {
    for (let i = 0; i < CHANNEL_COUNT; i += 1) {
      result[i] = normalizeKeyLabel(bindings[i]);
    }
    return result;
  }

  if (bindings && typeof bindings === 'object') {
    for (let i = 0; i < CHANNEL_COUNT; i += 1) {
      const channel = i + 1;
      result[i] = normalizeKeyLabel(
        bindings[channel] || bindings[String(channel)] || DEFAULT_BINDINGS[i]
      );
    }
  }

  return result;
}

function loadBindings() {
  return loadStoredState().bindings;
}

function saveBindings(bindings) {
  const current = loadStoredState();
  saveStoredState({
    ...current,
    bindings,
  });
}

function parseSensorLine(line) {
  const trimmed = String(line || '').trim();
  const sensorIds = new Set();

  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return sensorIds;
  }

  trimmed.split(',').forEach((part) => {
    const id = parseInt(part.trim(), 10);
    if (!Number.isNaN(id) && id >= 1 && id <= CHANNEL_COUNT) {
      sensorIds.add(id);
    }
  });

  return sensorIds;
}

function buildKeyOptions(selectedValue) {
  return KEY_OPTIONS.map((keyLabel) => {
    const label = keyLabel === 'SPACE' ? 'Space' : keyLabel || 'Unassigned';
    const value = keyLabel;
    const selected = value === selectedValue ? ' selected' : '';
    return `<option value="${value}"${selected}>${label}</option>`;
  }).join('');
}

function formatChannelLabel(channel) {
  return String(channel).padStart(2, '0');
}

function createSerialConfig({
  triggerKeyLabel,
  onSerialActivity,
  panelSelector = '#config-panel',
  baudRate = DEFAULT_BAUD_RATE,
} = {}) {
  const isSupported = typeof navigator !== 'undefined' && 'serial' in navigator;
  const $panel = $(panelSelector);
  const storedState = loadStoredState();
  const state = {
    bindings: storedState.bindings,
    activeChannels: new Set(),
    previousActiveKeys: new Set(),
    isConnected: false,
    lastLine: '',
    error: '',
    port: null,
    reader: null,
    readLoopActive: false,
    baudRate: storedState.baudRate || baudRate,
    triggerCooldownMs: storedState.triggerCooldownMs,
    sustainRepeats: normalizeSustainRepeats(storedState.sustainRepeats),
    autoReconnect: storedState.autoReconnect,
    lastTriggeredAtByKey: Object.create(null),
    releaseTimerByKey: Object.create(null),
  };

  function setPanelVisible(visible) {
    if (!$panel.length) {
      return;
    }

    if (visible) {
      $panel.removeAttr('hidden');
    } else {
      $panel.attr('hidden', 'hidden');
    }
  }

  function updateSupportCopy() {
    if (!$panel.length) {
      return;
    }

    $panel.find('#serial-support').text(
      isSupported
        ? 'Web Serial supported'
        : 'Web Serial is not supported in this browser'
    );
  }

  function updateStatus() {
    if (!$panel.length) {
      return;
    }

    const connectionText = state.isConnected
      ? 'Connected'
      : 'Disconnected';
    const lastLineText = state.lastLine || 'Waiting for serial data.';
    const errorText = state.error || '';
    const autoReconnectText = state.autoReconnect
      ? 'enabled'
      : 'disabled';

    $panel.find('#serial-connection').text(connectionText);
    $panel.find('#serial-last-line').text(lastLineText);
    $panel.find('#serial-error').text(errorText);
    $panel.find('#serial-baudrate-value').text(String(state.baudRate));
    $panel.find('#serial-cooldown-value').text(`${state.triggerCooldownMs} ms`);
    $panel.find('#serial-sustain-repeats-value').text(String(state.sustainRepeats));
    $panel.find('#serial-autoreconnect-value').text(autoReconnectText);

    $panel.find('#serial-connect').prop('disabled', !isSupported || state.isConnected);
    $panel.find('#serial-disconnect').prop('disabled', !state.isConnected);
  }

  function updateActiveChannels() {
    if (!$panel.length) {
      return;
    }

    const activeLabels = Array.from(state.activeChannels)
      .sort((a, b) => a - b)
      .map((channel) => `<span class="config-chip config-chip--active">${formatChannelLabel(channel)}</span>`)
      .join('');

    $panel.find('#serial-active').html(
      activeLabels || '<span class="config-chip">No active channels</span>'
    );

    $panel.find('[data-channel-row]').each((_, element) => {
      const $row = $(element);
      const channel = parseInt($row.attr('data-channel-row'), 10);
      $row.toggleClass('is-active', state.activeChannels.has(channel));
    });
  }

  function updateBindingsUI() {
    if (!$panel.length) {
      return;
    }

    $panel.find('[data-channel-select]').each((_, element) => {
      const $select = $(element);
      const channel = parseInt($select.attr('data-channel-select'), 10);
      $select.val(state.bindings[channel - 1] || '');
    });

    $panel.find('[data-channel-preview]').each((_, element) => {
      const $button = $(element);
      const channel = parseInt($button.attr('data-channel-preview'), 10);
      const keyLabel = state.bindings[channel - 1] || '';
      $button.text(keyLabel ? `Preview ${keyLabel}` : 'Preview');
      $button.prop('disabled', !keyLabel);
    });
  }

  function renderPanel() {
    if (!$panel.length) {
      return;
    }

    const channelRows = [];

    for (let channel = 1; channel <= CHANNEL_COUNT; channel += 1) {
      const keyLabel = state.bindings[channel - 1] || '';
      channelRows.push(`
        <div class="config-row" data-channel-row="${channel}">
          <div class="config-row__channel">
            <span class="config-row__badge">${formatChannelLabel(channel)}</span>
            <div class="config-row__meta">
              <strong>Channel ${channel}</strong>
              <span>Serial input ${channel}</span>
            </div>
          </div>
          <div class="config-row__controls">
            <select data-channel-select="${channel}" aria-label="Channel ${channel} key binding">
              ${buildKeyOptions(keyLabel)}
            </select>
            <button type="button" class="config-button config-button--ghost" data-channel-preview="${channel}">
              ${keyLabel ? `Preview ${keyLabel}` : 'Preview'}
            </button>
          </div>
        </div>
      `);
    }

    $panel.html(`
      <div class="config-panel__shell">
        <div class="config-panel__hero">
          <p class="config-panel__eyebrow">Configuration mode</p>
          <h1>Serial to action bindings</h1>
          <p class="config-panel__copy">
            Connect a Web Serial peripheral, watch the parsed channel IDs, and map each channel
            to a keyboard action. The selected key reuses the game's existing audio and animation
            trigger.
          </p>
        </div>

        <div class="config-panel__toolbar">
          <button type="button" class="config-button config-button--primary" id="serial-connect">
            Connect device
          </button>
          <button type="button" class="config-button" id="serial-disconnect">
            Disconnect
          </button>
          <button type="button" class="config-button" id="serial-reset">
            Reset defaults
          </button>
          <span class="config-panel__support" id="serial-support"></span>
        </div>

        <div class="config-panel__controls">
          <label class="config-field">
            <span class="config-field__label">Baud rate</span>
            <input type="number" min="300" step="100" id="serial-baudrate" value="${state.baudRate}">
          </label>
          <label class="config-field">
            <span class="config-field__label">Cooldown</span>
            <div class="config-field__inline">
              <input type="number" min="0" step="50" id="serial-cooldown" value="${state.triggerCooldownMs}">
              <span class="config-field__suffix">ms</span>
            </div>
          </label>
          <label class="config-field config-field--checkbox">
            <input type="checkbox" id="serial-autoreconnect" ${state.autoReconnect ? 'checked' : ''}>
            <span class="config-field__text-block">
              <span class="config-field__label-text">Auto-reconnect to the last authorized device</span>
              <span class="config-field__state" id="serial-autoreconnect-value">${state.autoReconnect ? 'enabled' : 'disabled'}</span>
            </span>
          </label>
          <label class="config-field">
            <span class="config-field__label">Sustain repeats</span>
            <input type="number" min="0" step="1" id="serial-sustain-repeats" value="${state.sustainRepeats}">
          </label>
        </div>

        <div class="config-panel__status">
          <div class="config-panel__status-item">
            <span class="config-panel__label">Connection</span>
            <strong id="serial-connection">Disconnected</strong>
          </div>
          <div class="config-panel__status-item">
            <span class="config-panel__label">Baud rate</span>
            <strong id="serial-baudrate-value">${state.baudRate}</strong>
          </div>
          <div class="config-panel__status-item">
            <span class="config-panel__label">Cooldown</span>
            <strong id="serial-cooldown-value">${state.triggerCooldownMs} ms</strong>
          </div>
          <div class="config-panel__status-item">
            <span class="config-panel__label">Sustain repeats</span>
            <strong id="serial-sustain-repeats-value">${state.sustainRepeats}</strong>
          </div>
          <div class="config-panel__status-item config-panel__status-item--wide">
            <span class="config-panel__label">Last line</span>
            <code id="serial-last-line">Waiting for serial data.</code>
          </div>
          <div class="config-panel__status-item config-panel__status-item--wide">
            <span class="config-panel__label">Active channels</span>
            <div class="config-panel__chips" id="serial-active">
              <span class="config-chip">No active channels</span>
            </div>
          </div>
          <div class="config-panel__status-item config-panel__status-item--wide config-panel__error" id="serial-error"></div>
        </div>

        <div class="config-panel__legend">
          Channel numbers are read from each serial line. Choose which keyboard action should fire
          when that channel appears. Shortcuts: press Backquote to toggle this panel, or ] to disconnect.
        </div>

        <div class="config-panel__grid" id="serial-mapping-grid">
          ${channelRows.join('')}
        </div>
      </div>
    `);

    $panel.find('[data-channel-select]').on('change', (event) => {
      const $select = $(event.currentTarget);
      const channel = parseInt($select.attr('data-channel-select'), 10);
      setBinding(channel, $select.val());
    });

    $panel.find('[data-channel-preview]').on('click', (event) => {
      const $button = $(event.currentTarget);
      const channel = parseInt($button.attr('data-channel-preview'), 10);
      previewChannel(channel);
    });

    $panel.find('#serial-connect').on('click', () => {
      connect();
    });

    $panel.find('#serial-disconnect').on('click', () => {
      disconnect();
    });

    $panel.find('#serial-reset').on('click', () => {
      state.bindings = DEFAULT_BINDINGS.slice();
      state.baudRate = DEFAULT_BAUD_RATE;
      state.triggerCooldownMs = DEFAULT_TRIGGER_COOLDOWN_MS;
      state.sustainRepeats = DEFAULT_SUSTAIN_REPEATS;
      state.autoReconnect = false;
      saveBindings(state.bindings);
      saveStoredState(state);
      $panel.find('#serial-baudrate').val(state.baudRate);
      $panel.find('#serial-cooldown').val(state.triggerCooldownMs);
      $panel.find('#serial-sustain-repeats').val(state.sustainRepeats);
      $panel.find('#serial-autoreconnect').prop('checked', false);
      updateBindingsUI();
      updateStatus();
    });

    $panel.find('#serial-baudrate').on('change input', (event) => {
      const value = Number.parseInt($(event.currentTarget).val(), 10);
      state.baudRate = Number.isNaN(value) ? DEFAULT_BAUD_RATE : Math.max(300, value);
      saveStoredState(state);
      updateStatus();
    });

    $panel.find('#serial-cooldown').on('change input', (event) => {
      const value = Number.parseInt($(event.currentTarget).val(), 10);
      state.triggerCooldownMs = Number.isNaN(value)
        ? DEFAULT_TRIGGER_COOLDOWN_MS
        : Math.max(0, value);
      saveStoredState(state);
      updateStatus();
    });

    $panel.find('#serial-sustain-repeats').on('change input', (event) => {
      state.sustainRepeats = normalizeSustainRepeats($(event.currentTarget).val());
      saveStoredState(state);
      updateStatus();
    });

    $panel.find('#serial-autoreconnect').on('change', (event) => {
      state.autoReconnect = $(event.currentTarget).is(':checked');
      saveStoredState(state);
      updateStatus();
    });

    updateSupportCopy();
    updateStatus();
    updateBindingsUI();
    updateActiveChannels();
  }

  function setBinding(channel, keyLabel) {
    const normalized = normalizeKeyLabel(keyLabel);

    if (channel < 1 || channel > CHANNEL_COUNT) {
      return;
    }

    state.bindings[channel - 1] = normalized;
    saveStoredState(state);
    updateBindingsUI();
  }

  function getBinding(channel) {
    if (channel < 1 || channel > CHANNEL_COUNT) {
      return '';
    }

    return state.bindings[channel - 1] || '';
  }

  function previewChannel(channel) {
    const keyLabel = getBinding(channel);
    if (!keyLabel || typeof triggerKeyLabel !== 'function') {
      return;
    }

    triggerKeyLabel(keyLabel, false);
  }

  function clearReleaseTimer(keyLabel) {
    const job = state.releaseTimerByKey[keyLabel];
    if (job && job.timer) {
      clearTimeout(job.timer);
    }
    if (job) {
      delete state.releaseTimerByKey[keyLabel];
    }
  }

  function resetChargeState() {
    Object.keys(state.releaseTimerByKey).forEach((keyLabel) => {
      clearReleaseTimer(keyLabel);
    });

    state.previousActiveKeys = new Set();
  }

  function fireChargedTrigger(keyLabel) {
    if (!keyLabel || typeof triggerKeyLabel !== 'function') {
      return false;
    }

    triggerKeyLabel(keyLabel, false, false);
    return true;
  }

  function getCooldownRemainingMs(keyLabel) {
    const lastTriggeredAt = state.lastTriggeredAtByKey[keyLabel] || 0;
    const remaining = state.triggerCooldownMs - (Date.now() - lastTriggeredAt);
    return Math.max(0, remaining);
  }

  function scheduleDrainStep(keyLabel) {
    const job = state.releaseTimerByKey[keyLabel];
    if (!job || job.remaining <= 0) {
      delete state.releaseTimerByKey[keyLabel];
      return;
    }

    const delay = Math.max(job.delay, getCooldownRemainingMs(keyLabel));

    job.timer = setTimeout(() => {
      const currentJob = state.releaseTimerByKey[keyLabel];
      if (!currentJob) {
        return;
      }

      if (!shouldTriggerKey(keyLabel)) {
        scheduleDrainStep(keyLabel);
        return;
      }

      fireChargedTrigger(keyLabel);
      currentJob.remaining -= 1;

      if (currentJob.remaining <= 0) {
        delete state.releaseTimerByKey[keyLabel];
        if (typeof onSerialActivity === 'function') {
          onSerialActivity();
        }
        return;
      }

      scheduleDrainStep(keyLabel);
    }, delay);
  }

  function scheduleSustain(keyLabel) {
    clearReleaseTimer(keyLabel);

    const sustainRepeats = state.sustainRepeats;
    if (sustainRepeats <= 0) {
      return;
    }

    state.releaseTimerByKey[keyLabel] = {
      remaining: sustainRepeats,
      delay: state.triggerCooldownMs,
      timer: null,
    };
    scheduleDrainStep(keyLabel);
  }

  function releaseMissingKeys(nextKeys) {
    state.previousActiveKeys.forEach((keyLabel) => {
      if (!nextKeys.has(keyLabel)) {
        scheduleSustain(keyLabel);
      }
    });
  }

  function shouldTriggerKey(keyLabel) {
    if (!keyLabel) {
      return false;
    }

    const now = Date.now();
    const lastTriggeredAt = state.lastTriggeredAtByKey[keyLabel] || 0;

    if (now - lastTriggeredAt < state.triggerCooldownMs) {
      return false;
    }

    state.lastTriggeredAtByKey[keyLabel] = now;
    return true;
  }

  function handleSensorIds(sensorIds) {
    state.activeChannels = sensorIds instanceof Set ? sensorIds : new Set();
    updateActiveChannels();

    const currentKeys = new Set();
    let didTrigger = false;

    state.activeChannels.forEach((channel) => {
      const keyLabel = getBinding(channel);
      if (!keyLabel) {
        return;
      }

      currentKeys.add(keyLabel);
      clearReleaseTimer(keyLabel);

      if (shouldTriggerKey(keyLabel)) {
        fireChargedTrigger(keyLabel);
        didTrigger = true;
      }
    });

    releaseMissingKeys(currentKeys);
    state.previousActiveKeys = currentKeys;

    if (didTrigger && typeof onSerialActivity === 'function') {
      onSerialActivity();
    }
  }

  function handleSerialLine(line) {
    state.lastLine = String(line || '').trim();
    const sensorIds = parseSensorLine(state.lastLine);
    handleSensorIds(sensorIds);
    updateStatus();
  }

  async function disconnect() {
    try {
      if (state.reader) {
        await state.reader.cancel();
        state.reader = null;
      }

      if (state.port) {
        await state.port.close();
        state.port = null;
      }
    } catch (error) {
      state.error = `Disconnect error: ${error.message}`;
    } finally {
      state.isConnected = false;
      state.readLoopActive = false;
      state.port = null;
      resetChargeState();
      updateStatus();
    }
  }

  async function connectToAuthorizedPort() {
    if (!isSupported || !navigator.serial.getPorts) {
      return false;
    }

    try {
      const ports = await navigator.serial.getPorts();
      if (!ports.length) {
        return false;
      }

      resetChargeState();
      state.error = '';
      state.port = ports[0];
      await state.port.open({ baudRate: state.baudRate });
      state.isConnected = true;
      updateStatus();
      readSerial();
      return true;
    } catch (error) {
      state.error = `Auto-connect error: ${error.message}`;
      state.port = null;
      state.isConnected = false;
      updateStatus();
      return false;
    }
  }

  async function readSerial() {
    if (!state.port || !state.port.readable) {
      return;
    }

    state.readLoopActive = true;

    try {
      const textDecoder = new TextDecoderStream();
      const readableStreamClosed = state.port.readable.pipeTo(textDecoder.writable);
      state.reader = textDecoder.readable.getReader();
      let buffer = '';

      while (state.readLoopActive) {
        const { value, done } = await state.reader.read();
        if (done) {
          break;
        }

        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach((line) => {
          if (line.trim()) {
            handleSerialLine(line);
          }
        });
      }

      await readableStreamClosed.catch(() => {});
    } catch (error) {
      if (error.name !== 'AbortError') {
        state.error = `Serial read error: ${error.message}`;
      }
    } finally {
      state.reader = null;
      state.readLoopActive = false;
      state.isConnected = false;
      updateStatus();
    }
  }

  async function connect() {
    if (!isSupported) {
      state.error = 'Web Serial is not supported in this browser';
      updateStatus();
      return;
    }

    try {
      state.error = '';
      resetChargeState();
      await disconnect();
      state.port = await navigator.serial.requestPort();
      await state.port.open({ baudRate: state.baudRate });
      state.isConnected = true;
      state.autoReconnect = true;
      saveStoredState(state);
      updateStatus();
      readSerial();
    } catch (error) {
      if (error.name !== 'NotFoundError') {
        state.error = `Connection error: ${error.message}`;
      }
      state.isConnected = false;
      state.port = null;
      updateStatus();
    }
  }

  if ($panel.length) {
    renderPanel();
    setPanelVisible(false);
  }

  window.addEventListener('beforeunload', () => {
    disconnect();
  });

  return {
    isSupported,
    connect,
    disconnect,
    handleSerialLine,
    handleSensorIds,
    connectToAuthorizedPort,
    setVisible(visible) {
      setPanelVisible(visible);
      if (visible && state.autoReconnect && !state.isConnected) {
        connectToAuthorizedPort();
      }
      updateSupportCopy();
      updateStatus();
      updateActiveChannels();
      updateBindingsUI();
    },
    getBinding,
    setBinding,
    setBaudRate(nextBaudRate) {
      state.baudRate = Math.max(300, Number.parseInt(nextBaudRate, 10) || DEFAULT_BAUD_RATE);
      saveStoredState(state);
      updateStatus();
    },
    setTriggerCooldownMs(nextCooldownMs) {
      state.triggerCooldownMs = Math.max(0, Number.parseInt(nextCooldownMs, 10) || DEFAULT_TRIGGER_COOLDOWN_MS);
      saveStoredState(state);
      updateStatus();
    },
    setAutoReconnect(nextAutoReconnect) {
      state.autoReconnect = !!nextAutoReconnect;
      saveStoredState(state);
      updateStatus();
    },
    getBindings() {
      return state.bindings.slice();
    },
    refresh() {
      updateSupportCopy();
      updateStatus();
      updateActiveChannels();
      updateBindingsUI();
    },
    state,
  };
}

export { CHANNEL_COUNT, DEFAULT_BINDINGS, KEY_OPTIONS, createSerialConfig, loadBindings, normalizeKeyLabel, parseSensorLine };