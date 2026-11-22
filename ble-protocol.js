// ble-protocol.js — Marshall / Zound BLE protocol (device-agnostic).
// Classic script (no ESM) to avoid file:// module CORS in Electron. Exposes window.BLE.
// Encode/decode only; no transport. See PROTOCOL.md for the reverse-engineered spec.
(function () {
  const Z = '-1337-1dea-feed-c0ffee70c0de'; // custom Zound base
  const S = '-0000-1000-8000-00805f9b34fb'; // standard Bluetooth base
  const custom = (h) => `0000${h}${Z}`;
  const sig = (h) => `0000${h}${S}`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));

  window.BLE = {
    COMPANY_IDS: [0x065a, 0x5a06], // 1626, 23046

    SERVICES: {
      ZOUND: sig('fccd'),
      LEGACY: sig('aa00'),
      INFO: sig('180a'),
      BATTERY: sig('180f'),
    },

    // Each control: preferred custom UUID + legacy fallback. Device info = standard only.
    CHARS: {
      VOLUME: { key: 'VOLUME', uuid: custom('0007'), legacy: sig('aa08') },
      VOLUME_LIMIT: { key: 'VOLUME_LIMIT', uuid: custom('0008'), legacy: sig('aa09') },
      AUDIO_SOURCE: { key: 'AUDIO_SOURCE', uuid: custom('001b'), legacy: sig('aa29') },
      NIGHT_MODE: { key: 'NIGHT_MODE', uuid: custom('001f'), legacy: sig('aa2d') },
      GRAPHICAL_EQ: { key: 'GRAPHICAL_EQ', uuid: custom('000f'), legacy: sig('aa16') },
      AUDIO_CONTROL: { key: 'AUDIO_CONTROL', uuid: custom('0009'), legacy: sig('aa10') },
      MODEL_NAME: { key: 'MODEL_NAME', uuid: sig('2a24') },
      FIRMWARE: { key: 'FIRMWARE', uuid: sig('2a26') },
      BATTERY: { key: 'BATTERY', uuid: sig('2a19') },
    },

    SOURCE_CODE: { bt: 0, wifi: 1, aux: 2, rca: 3, optical: 4, hdmi: 5, bleaudio: 6, usbc: 7, broadcast: 8, hdmiearc: 9 },
    SOURCE_LABEL: { 0: 'Bluetooth', 1: 'Wi-Fi', 2: 'AUX', 3: 'RCA', 4: 'Optical', 5: 'HDMI', 6: 'BLE Audio', 7: 'USB-C', 8: 'Broadcast', 9: 'HDMI eARC' },

    enc: {
      volume: (v) => Uint8Array.of(clamp(v, 0, 127)),
      source: (code) => Uint8Array.of(code & 0xff),
      night: (on) => Uint8Array.of(on ? 1 : 0),
      eq5: (arr) => Uint8Array.from(arr.slice(0, 5).map((x) => x & 0xff)), // [bass,low,mid,upper,treble]
    },

    dec: {
      volume: (dv) => (dv.byteLength === 1 && dv.getUint8(0) <= 127 ? dv.getUint8(0) : -1),
      night: (dv) => dv.byteLength > 0 && dv.getUint8(0) === 1,
      source: (dv) => {
        if (!dv.byteLength) return 0;
        const b0 = dv.getUint8(0);
        if (b0 === 0xfe) return dv.byteLength >= 6 ? dv.getUint8(5) : 0; // extended frame
        return b0;
      },
      eq5: (dv) => Array.from({ length: 5 }, (_, i) => (i < dv.byteLength ? dv.getUint8(i) : 0)),
      str: (dv) => new TextDecoder().decode(dv).replace(/\u0000+$/, '').trim(),
      u8: (dv) => (dv.byteLength ? dv.getUint8(0) : 0),
    },
  };
})();
