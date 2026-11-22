# ble_bridge.py — Marshall/Zound BLE engine for the Electron app.
# Talks line-delimited JSON over stdin/stdout. Uses Bleak (WinRT) which can
# initiate LE bonding (pair()) — required to WRITE the encrypted characteristics.
# PREREQUISITE on Windows: the speaker's Classic "Audio" device must be paired
# in Windows once (that association lets the LE link bond via CTKD).
import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import asyncio
import json
import threading
import warnings
from bleak import BleakScanner, BleakClient

# IMPORTANT: pycaw/comtypes are imported LAZILY inside _read_speaker_pct (on a worker thread).
# Importing comtypes on the MAIN thread sets it to an STA/GUI COM apartment, which breaks Bleak's
# WinRT callbacks → "Thread is configured for Windows GUI but callbacks are not working" (scan dies).

Z = '-1337-1dea-feed-c0ffee70c0de'
S = '-0000-1000-8000-00805f9b34fb'
cu = lambda h: f'0000{h}{Z}'
sg = lambda h: f'0000{h}{S}'

COMPANY_IDS = {0x065a, 0x5a06}
# key -> (custom uuid, legacy uuid or None)
CHARS = {
    'VOLUME': (cu('0007'), sg('aa08')),
    'VOLUME_LIMIT': (cu('0008'), sg('aa09')),
    'AUDIO_SOURCE': (cu('001b'), sg('aa29')),
    'NIGHT_MODE': (cu('001f'), sg('aa2d')),
    'GRAPHICAL_EQ': (cu('000f'), sg('aa16')),
    'AUDIO_CONTROL': (cu('0009'), sg('aa10')),
    'MODEL_NAME': (sg('2a24'), None),
    'FIRMWARE': (sg('2a26'), None),
    'BATTERY': (sg('2a19'), None),
}
INITIAL_READS = ['MODEL_NAME', 'FIRMWARE', 'BATTERY', 'VOLUME_LIMIT', 'VOLUME', 'AUDIO_SOURCE', 'NIGHT_MODE', 'GRAPHICAL_EQ']
NOTIFY = ['VOLUME', 'AUDIO_SOURCE', 'NIGHT_MODE', 'BATTERY']

out_lock = threading.Lock()


def send(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()


def log(msg):
    send({'evt': 'log', 'message': str(msg)})


def _read_speaker_pct(hint='stanmore'):
    # Windows master volume % of the Marshall A2DP endpoint (what Windows shows). Runs on a WORKER thread.
    try:
        import comtypes
        from comtypes import CLSCTX_ALL, cast, POINTER
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
    except Exception:
        return None
    comtypes.CoInitialize()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            for d in AudioUtilities.GetAllDevices():
                n = (d.FriendlyName or '').lower()
                if hint in n or 'marshall' in n:
                    try:
                        iface = d._dev.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
                        epv = cast(iface, POINTER(IAudioEndpointVolume))
                        return round(epv.GetMasterVolumeLevelScalar() * 100)
                    except Exception:
                        continue
        return None
    finally:
        comtypes.CoUninitialize()


scanner = None
devices = {}   # address -> BLEDevice
client = None
present = {}    # key -> characteristic object
suppress_disc = False  # mute disconnect events during the connect/pair/reconnect dance
_pending_write = {}    # char_key -> latest bytes (coalesced so fast drags don't back up the BLE link)
_writer_tasks = {}     # char_key -> background drain task
_ble_lock = asyncio.Lock()  # serialize GATT ops (Bleak isn't concurrency-safe)


async def do_scan():
    global scanner, devices
    await do_stop_scan()
    devices = {}

    def cb(d, adv):
        up = (d.name or '').upper()
        comp = set((adv.manufacturer_data or {}).keys())
        if (comp & COMPANY_IDS) or '[LE]' in up or 'STANMORE' in up or 'MARSHALL' in up or 'ACTON' in up or 'WOBURN' in up:
            prev = devices.get(d.address)
            devices[d.address] = d
            prev_name = prev.name if prev else None
            # emit on first sight, and again when a real name finally arrives (active-scan name may lag)
            if prev is None or (d.name and d.name != prev_name):
                send({'evt': 'device', 'address': d.address, 'name': d.name or d.address})

    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    send({'evt': 'scanning'})


async def do_stop_scan():
    global scanner
    if scanner is not None:
        try:
            await scanner.stop()
        except Exception:
            pass
        scanner = None


def make_notify(key):
    def handler(_sender, data):
        send({'evt': 'value', 'char': key, 'hex': bytes(data).hex()})
    return handler


def on_disconnect(_c):
    if suppress_disc:
        return
    send({'evt': 'disconnected'})


async def _connect_retry(n=3):
    for i in range(1, n + 1):
        try:
            await client.connect()
            return True
        except Exception as e:
            log(f'connect attempt {i}: {e}')
            await asyncio.sleep(1.5)
    return False


def _resolve_present():
    # map known char keys -> live characteristic objects (first match per key)
    global present
    present = {}
    for svc in client.services:
        for ch in svc.characteristics:
            u = ch.uuid.lower()
            for key, (cust, leg) in CHARS.items():
                if key in present:
                    continue
                if u == cust.lower() or (leg and u == leg.lower()):
                    present[key] = ch


async def do_connect(address):
    global client, present
    await do_stop_scan()
    dev = devices.get(address)
    if dev is None:
        send({'evt': 'error', 'where': 'connect', 'message': 'device not in scan cache'})
        return

    global suppress_disc
    send({'evt': 'status', 'text': 'Connecting'})
    client = BleakClient(dev, timeout=20.0, disconnected_callback=on_disconnect)
    suppress_disc = True
    try:
        if not await _connect_retry(3):
            send({'evt': 'error', 'where': 'connect', 'message': 'could not connect — pair the Classic "STANMORE III" audio device in Windows first'})
            client = None
            return
        send({'evt': 'status', 'text': 'Pairing'})
        try:
            await client.pair()
        except Exception as e:
            log(f'pair: {e}')
        # pairing can briefly drop the link; reconnect once for the encrypted session
        if not client.is_connected:
            await _connect_retry(3)
    finally:
        suppress_disc = False

    if client is None or not client.is_connected:
        send({'evt': 'error', 'where': 'connect', 'message': 'could not establish an encrypted session'})
        client = None
        return

    _resolve_present()
    name = None
    if 'MODEL_NAME' in present:
        try:
            name = bytes(await client.read_gatt_char(present['MODEL_NAME'])).decode('utf-8', 'ignore').strip('\x00').strip()
        except Exception:
            name = None
    send({'evt': 'connected', 'chars': list(present.keys()), 'name': name or (client.address or '')})

    for key in INITIAL_READS:
        if key in present:
            try:
                v = bytes(await client.read_gatt_char(present[key]))
                send({'evt': 'value', 'char': key, 'hex': v.hex()})
            except Exception as e:
                log(f'read {key}: {e}')

    for key in NOTIFY:
        if key in present and 'notify' in present[key].properties:
            try:
                await client.start_notify(present[key], make_notify(key))
            except Exception as e:
                log(f'notify {key}: {e}')
    send({'evt': 'ready'})


async def _drain_writes(key):
    ch = present.get(key)
    if ch is None:
        _writer_tasks.pop(key, None)
        _pending_write.pop(key, None)
        return
    # prefer write-without-response (no round-trip) for snappy live updates
    resp = ('write' in ch.properties) and ('write-without-response' not in ch.properties)
    try:
        while client is not None and key in _pending_write:
            data = _pending_write.pop(key)  # always the LATEST; intermediates are dropped
            try:
                async with _ble_lock:
                    await client.write_gatt_char(ch, data, response=resp)
            except Exception as e:
                send({'evt': 'error', 'where': 'write', 'char': key, 'message': str(e)})
                break
    finally:
        _writer_tasks.pop(key, None)


async def do_write(key, hexstr):
    # Coalesce: keep only the latest value per char and drain it in the background, so a fast
    # volume drag doesn't queue dozens of writes that crawl to the target after you let go.
    if client is None or key not in present:
        return
    _pending_write[key] = bytes.fromhex(hexstr)
    if key not in _writer_tasks:
        _writer_tasks[key] = asyncio.create_task(_drain_writes(key))


async def do_calibrate():
    # Sweep BLE volume steps 0..limit, read each step's real Windows %, build a lookup table, restore.
    if client is None or 'VOLUME' not in present:
        send({'evt': 'error', 'where': 'calibrate', 'message': 'not connected'})
        return
    if await asyncio.to_thread(_read_speaker_pct) is None:
        send({'evt': 'error', 'where': 'calibrate', 'message': 'Windows audio "STANMORE III" not found (or pycaw missing) — connect it as an audio device first'})
        return

    vol_ch = present['VOLUME']
    limit = 31
    if 'VOLUME_LIMIT' in present:
        try:
            limit = bytes(await client.read_gatt_char(present['VOLUME_LIMIT']))[0]
        except Exception:
            pass
    try:
        orig = bytes(await client.read_gatt_char(vol_ch))[0]
    except Exception:
        orig = 0

    table = []
    for step in range(0, limit + 1):
        try:
            async with _ble_lock:
                await client.write_gatt_char(vol_ch, bytes([step]), response=True)
        except Exception as e:
            send({'evt': 'error', 'where': 'calibrate', 'message': f'write {step}: {e}'})
            break
        await asyncio.sleep(0.4)  # let AVRCP propagate to Windows
        pct = await asyncio.to_thread(_read_speaker_pct)
        table.append(pct if pct is not None else round(step / max(1, limit) * 100))
        send({'evt': 'calibrateProgress', 'step': step, 'max': limit, 'percent': table[-1]})

    try:
        async with _ble_lock:
            await client.write_gatt_char(vol_ch, bytes([orig]), response=True)  # restore
    except Exception:
        pass
    send({'evt': 'calibrateDone', 'limit': limit, 'table': table})


async def do_disconnect():
    global client
    await do_stop_scan()
    _pending_write.clear()
    if client is not None:
        try:
            await client.disconnect()
        except Exception:
            pass
        client = None


async def handle(cmd):
    c = cmd.get('cmd')
    if c == 'scan':
        await do_scan()
    elif c == 'stopScan':
        await do_stop_scan()
        send({'evt': 'scanStopped'})
    elif c == 'connect':
        await do_connect(cmd['address'])
    elif c == 'disconnect':
        await do_disconnect()
    elif c == 'write':
        await do_write(cmd['char'], cmd['hex'])
    elif c == 'calibrate':
        await do_calibrate()


async def main():
    loop = asyncio.get_running_loop()
    q = asyncio.Queue()

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            loop.call_soon_threadsafe(q.put_nowait, obj)
        loop.call_soon_threadsafe(q.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()
    send({'evt': 'bridge_ready'})

    while True:
        cmd = await q.get()
        if cmd is None:
            break
        try:
            await handle(cmd)
        except Exception as e:
            send({'evt': 'error', 'where': 'handle', 'message': str(e)})
    await do_disconnect()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
