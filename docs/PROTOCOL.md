# Marshall / Zound BLE — Protocol Spec

Reverse-engineered from the Marshall Bluetooth Android app `com.zoundindustries.marshallbt`
v3.9.2 (static analysis, for building our own controller for a speaker we own).
Package: `com.zoundindustries.bleprotocol.connectionservice.api.gatt`.

## UUID construction

Each `BLECharacteristic` holds a **custom** UUID and (usually) a **legacy** UUID. A client
should discover both and use whichever the device's GATT table exposes — the app prefers the
custom one and falls back to legacy (`BaseCharacteristicWrapper.o()`).

```
custom(XXXX) = 0000XXXX-1337-1dea-feed-c0ffee70c0de
legacy(XXXX) = 0000XXXX-0000-1000-8000-00805f9b34fb   (standard Bluetooth base)
OTA   (XXXX) = 0000XXXX-d102-11e1-9b23-00025b00a5a5   (Qualcomm GAIA, older devices)
CCCD         = 00002902-0000-1000-8000-00805f9b34fb   (notify/indicate descriptor)
```

## GATT services

| Service | UUID | Holds |
|---|---|---|
| ZOUND (new) | `0000fccd-0000-1000-8000-00805f9b34fb` | modern characteristics (custom UUIDs) |
| LEGACY_ZOUND | `0000aa00-0000-1000-8000-00805f9b34fb` | legacy characteristics (`aaXX`) |
| DEVICE_INFO | `0000180a-…` | model / firmware / serial |
| BATTERY | `0000180f-…` | battery level |

## Codec contract

Each characteristic has a wrapper extending `BaseCharacteristicWrapper<T>`:
`T t(byte[])` = parse on read/notify; `byte[] u(T)` = serialize on write.

---

## Characteristics

### VOLUME — `0007` / legacy `aa08`  (wrapper `zound.Z`)
- R / W / notify. **1 byte = level.**
- Accepted range **0–127** (`0x00–0x7F`); byte ≥ 0x80 is rejected and parsed as `-1` (invalid).
- No max clamp here — ceiling is enforced by VOLUME_LIMIT (`0008`/`aa09`).

### AUDIO_CONTROL — `0009` / legacy `aa10`  (wrapper `zound.C10177f`)
- R / W / notify. **1 byte = command.**
- `0x00 PAUSE · 0x01 PLAY · 0x02 PREV · 0x03 NEXT`. Unknown/empty read → PAUSE.

### AUDIO_SOURCE — `001b` / legacy `aa29`  (wrapper `zound.C10184m`)
- R / W / notify. **WRITE = 1 byte = source code.**
- Codes: `0 BLUETOOTH · 1 WIFI · 2 AUX · 3 RCA · 4 OPTICAL · 5 HDMI · 6 BLE_AUDIO · 7 USB_C · 8 BROADCAST · 9 HDMI_eARC · 0xFF ERROR`.
- READ: if `data[0]==0xFE` → extended frame (BE): `[0]=0xFE, [3..4]=uint16 supported-source bitmask (bit=ordinal), [5]=current code`; else `current = code(data[0])`.

### TONE_CONTROL — `0025` / legacy `aa33`  (wrapper `zound.T`)
- R / W. **1 byte = tone preset** (NOT bass/treble): `0 VOICE_CLARITY · 1 MARSHALL · 2 BOOST`. Unknown → MARSHALL.

### GRAPHICAL_EQUALIZER — `000f` / legacy `aa16`  (wrapper `zound.C10194x`, codec `zound.C10196z`)
- R / W. **The real multi-band EQ. 5 bytes = `[bass, low, mid, upper, treble]`** (same order both ways).
- Each band `0–10`. Bands low/mid/upper may be `0xFF` = "band not present". Bass & treble must be `0–10`.
- Optional 8-byte extended write (3 trailing `0x00`). Invalid frame parses to all-zeros.
- **Stanmore III Bass/Treble knobs = bands index 0 and 4 here.**

### EQUALIZER_SETTINGS — `0017` / legacy `aa25`  (wrapper `zound.G`)
- Preset / active-step control.
- WRITE: `[0x00, step]` (change active step, 2 B) or `[0x01, step, preset]` (assign preset to step, 3 B).
- `EqStep`: STEP_1=0, STEP_2=1, STEP_3=2.
- `EqStepPreset` (family presetId=0): FLAT=0, CUSTOM=1, ROCK=2, METAL=3, POP=4, HIPHOP=5, ELECTRONIC=6, JAZZ=7, VOCALBOOSTER=8.

### EQUALIZER_SETTINGS_CUSTOM_PRESET — `0018` / legacy `aa26`  (wrapper `zound.A`)
- Same 5-band `[bass, low, mid, upper, treble]` codec as GRAPHICAL_EQUALIZER; WRITE always 5 bytes.

### NIGHT_MODE — `001f` / legacy `aa2d`  (wrapper `zound.J`)
- R / W. **1 byte**: `0x01` ON, `0x00` OFF.

### RENAME — `0003` / legacy `aa04`  (wrapper `zound.N`)
- WRITE-only here. **Raw UTF-8 bytes** of the name (no length prefix, no NUL). Read via GAP device name elsewhere.

### AUTO_POWER_OFF — `0004` / legacy `aa05`  (wrapper `zound.r`)
- R / W. **1 byte 0–255** (legacy single timer). Unit not defined in BLE layer (likely minutes, applied UI-side).

### AUTO_OFF_TIMER — `0032` (no legacy)  (wrapper `zound.C10186o`)
- Multi-timer, framed. **Write/read framing are asymmetric** — build independently:
  - WRITE: `[count u8]([disableState u8] if present)` then count × `[id u8][typeConf u8][value u16 BE]`.
  - READ: `[flags u8][count u8][reserved u8]([disableState u8] if flags.bit0)` then count × `[id u8][value u16 BE][typeConf u8]`.
- `BleTimerDisableState`: DISABLED=0x01, ENABLED=0x00. `TimerType.conf` bitflags: BT_CONNECTED=0x01, BT_NOT_CONNECTED=0x02, NOT_WORN=0x04, GENERAL=0x08.

### Device info (read-only, standard BLE)
| Char | UUID | Parse |
|---|---|---|
| MODEL_NAME | `2a24` (wrapper `E3.e`) | UTF-8 string |
| FIRMWARE_REVISION | `2a26` (wrapper `E3.b`) | UTF-8 string |
| BATTERY_LEVEL | `2a19` (wrapper `D3.d`) | uint8 0–100 (clamp defensively) |

---

## Scanning / discovery (from `DiscoveryManager` + `AdvertisementDataHelper`)

- BLE scan filtered by **manufacturer company ID `1626` (0x065A)** or `23046` (0x5A06).
- Manufacturer data bytes: `[0]` device type, `[1]` color, `[2..7]` id, `[8]` pairing-mode flag (`1` = ready to pair).
- Advertised name starts with `LE-`. ScanMode = LOW_LATENCY.

## Open items (not resolved statically)
- Exact dB value per EQ step `0–10` (UI-layer mapping).
- Unit of AUTO_POWER_OFF / AUTO_OFF_TIMER value (UI-layer).
- Whether the ZOUND service characteristics require an encrypted/bonded link — **must be tested on real hardware.**
