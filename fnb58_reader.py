#!/usr/bin/env python3
"""
FNB58 Reader
Lee datos del FNIRSI FNB-58 via interfaz HID (la correcta).
Basado en el protocolo confirmado por baryluk/fnirsi-usb-power-data-logger.
"""

import usb.core
import usb.util
import struct
import time
import sys
import signal
import threading
from datetime import datetime
from collections import deque

# ─── Dispositivo ─────────────────────────────────────────────────────────────
VID = 0x2E3C
PID = 0x5558

# ─── Protocolo ───────────────────────────────────────────────────────────────
# Secuencia de inicialización (baryluk confirmed)
INIT_CMD_1    = b"\xaa\x81" + b"\x00" * 61 + b"\x8e"
INIT_CMD_2    = b"\xaa\x82" + b"\x00" * 61 + b"\x96"
KEEPALIVE_CMD = b"\xaa\x83" + b"\x00" * 61 + b"\x9e"

PACKET_TYPE_DATA = 0x04
SAMPLES_PER_PACKET = 4
SAMPLE_SIZE = 15           # bytes por muestra
SAMPLE_RATE = 100          # Hz
TIME_INTERVAL = 1.0 / SAMPLE_RATE


def find_hid_interface(dev):
    """Devuelve la interfaz HID (class=0x03) del dispositivo"""
    for cfg in dev:
        for intf in cfg:
            if intf.bInterfaceClass == 0x03:
                return intf
    return None


def detach_all_kernels(dev):
    """Desvincula todos los drivers del kernel"""
    for cfg in dev:
        for intf in cfg:
            try:
                if dev.is_kernel_driver_active(intf.bInterfaceNumber):
                    dev.detach_kernel_driver(intf.bInterfaceNumber)
            except usb.core.USBError:
                pass


def decode_sample(data, offset):
    """
    Decodifica una muestra de 15 bytes.
    Formato: V(4LE) I(4LE) D+(2LE) D-(2LE) unk(1) T(2LE)
    """
    voltage = struct.unpack_from('<I', data, offset)[0]     / 100000.0
    current = struct.unpack_from('<I', data, offset + 4)[0] / 100000.0
    dp      = struct.unpack_from('<H', data, offset + 8)[0]  / 1000.0
    dn      = struct.unpack_from('<H', data, offset + 10)[0] / 1000.0
    temp    = struct.unpack_from('<H', data, offset + 13)[0] / 10.0
    return {
        'voltage':     round(voltage, 5),
        'current':     round(current, 5),
        'power':       round(voltage * current, 5),
        'dp':          round(dp, 3),
        'dn':          round(dn, 3),
        'temperature': round(temp, 1),
    }


def decode_packet(data):
    """
    Decodifica un paquete de 64 bytes.
    Retorna lista de hasta 4 muestras, o [] si no es paquete de datos.
    """
    raw = bytes(data)
    if len(raw) < 2:
        return []
    if raw[0] != 0xaa:
        return []
    if raw[1] != PACKET_TYPE_DATA:
        return []

    samples = []
    for i in range(SAMPLES_PER_PACKET):
        offset = 2 + SAMPLE_SIZE * i
        if offset + SAMPLE_SIZE > len(raw):
            break
        samples.append(decode_sample(raw, offset))
    return samples


class FNB58Reader:
    """Lector del FNIRSI FNB-58 via HID"""

    def __init__(self):
        self.dev    = None
        self.ep_in  = None
        self.ep_out = None
        self.running = False
        self._thread = None
        self._callbacks = []
        self.buffer = deque(maxlen=10000)
        self._energy_Wh  = 0.0
        self._capacity_mAh = 0.0
        self._last_reading = None

    # ── Conexión ─────────────────────────────────────────────────────────────

    def connect(self):
        self.dev = usb.core.find(idVendor=VID, idProduct=PID)
        if self.dev is None:
            raise ConnectionError(f"Dispositivo no encontrado (VID={VID:#06x} PID={PID:#06x})")

        detach_all_kernels(self.dev)

        try:
            self.dev.set_configuration()
        except usb.core.USBError:
            pass

        intf = find_hid_interface(self.dev)
        if intf is None:
            raise ConnectionError("Interfaz HID no encontrada en el dispositivo")

        # Reclamar la interfaz explícitamente
        try:
            usb.util.claim_interface(self.dev, intf.bInterfaceNumber)
        except usb.core.USBError as e:
            raise ConnectionError(f"No se puede reclamar la interfaz HID: {e}")

        self.ep_out = usb.util.find_descriptor(intf, custom_match=lambda e:
            usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT)
        self.ep_in  = usb.util.find_descriptor(intf, custom_match=lambda e:
            usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN)

        if self.ep_in is None or self.ep_out is None:
            raise ConnectionError("Endpoints HID no encontrados")

        # Secuencia de inicialización (tres comandos para FNB58)
        self.ep_out.write(INIT_CMD_1)
        self.ep_out.write(INIT_CMD_2)
        self.ep_out.write(INIT_CMD_2)

        info = self.device_info()
        print(f"Conectado: {info['manufacturer']} {info['product']} [{info['serial']}]")
        print(f"Interfaz HID: ep_in=0x{self.ep_in.bEndpointAddress:02x}  "
              f"ep_out=0x{self.ep_out.bEndpointAddress:02x}")
        return True

    def disconnect(self):
        self.stop()
        if self.dev:
            try:
                intf = find_hid_interface(self.dev)
                if intf:
                    usb.util.release_interface(self.dev, intf.bInterfaceNumber)
            except Exception:
                pass
            try:
                usb.util.dispose_resources(self.dev)
            except Exception:
                pass
        self.dev = None

    def device_info(self):
        d = self.dev
        def gs(idx): return usb.util.get_string(d, idx) if idx else "?"
        return {
            'manufacturer': gs(d.iManufacturer),
            'product':      gs(d.iProduct),
            'serial':       gs(d.iSerialNumber),
            'vid': f"{d.idVendor:#06x}",
            'pid': f"{d.idProduct:#06x}",
        }

    # ── Lectura ──────────────────────────────────────────────────────────────

    def register_callback(self, fn):
        """fn(reading) se llama por cada muestra recibida"""
        self._callbacks.append(fn)

    def start(self):
        self.running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self.running = False
        if self._thread:
            self._thread.join(timeout=3)

    def _loop(self):
        time.sleep(0.1)
        next_keepalive = time.time() + 1.0

        while self.running:
            try:
                data = self.ep_in.read(size_or_buffer=64, timeout=2000)
                samples = decode_packet(data)

                for s in samples:
                    # Acumular energía y capacidad
                    self._energy_Wh    += s['power']   * TIME_INTERVAL / 3600.0
                    self._capacity_mAh += s['current'] * TIME_INTERVAL / 3.6

                    reading = {
                        **s,
                        'timestamp':    datetime.now().isoformat(),
                        'energy_Wh':    round(self._energy_Wh, 6),
                        'capacity_mAh': round(self._capacity_mAh, 4),
                    }
                    self._last_reading = reading
                    self.buffer.append(reading)
                    for cb in self._callbacks:
                        try:
                            cb(reading)
                        except Exception as e:
                            print(f"[callback error] {e}", file=sys.stderr)

                # Keep-alive cada 1 segundo
                if time.time() >= next_keepalive:
                    next_keepalive = time.time() + 1.0
                    self.ep_out.write(KEEPALIVE_CMD)

            except usb.core.USBError as e:
                if self.running:
                    print(f"[USB] {e}", file=sys.stderr)
                    time.sleep(0.1)

    def latest(self):
        return self._last_reading

    def recent(self, n=100):
        data = list(self.buffer)
        return data[-n:]

    def reset_accumulators(self):
        self._energy_Wh    = 0.0
        self._capacity_mAh = 0.0


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    reader = FNB58Reader()

    try:
        reader.connect()
    except ConnectionError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    print()
    print(f"{'timestamp':<26} {'V':>8} {'A':>8} {'W':>8} "
          f"{'D+':>6} {'D-':>6} {'°C':>6} {'Wh':>10} {'mAh':>10}")
    print("-" * 96)

    def on_reading(r):
        ts = r['timestamp'][11:23]   # solo HH:MM:SS.mmm
        print(f"{ts:<26} {r['voltage']:>8.5f} {r['current']:>8.5f} {r['power']:>8.5f} "
              f"{r['dp']:>6.3f} {r['dn']:>6.3f} {r['temperature']:>6.1f} "
              f"{r['energy_Wh']:>10.6f} {r['capacity_mAh']:>10.4f}")

    reader.register_callback(on_reading)

    def handle_exit(sig, frame):
        print("\nParando...", file=sys.stderr)
        reader.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_exit)
    signal.signal(signal.SIGTERM, handle_exit)

    reader.start()

    # Mantener el hilo principal vivo
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
