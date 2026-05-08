# FNB58 Monitor

Dashboard web en tiempo real para el medidor USB **FNIRSI FNB58**.
Conecta el dispositivo al ordenador y monitoriza voltaje, corriente, potencia y temperatura desde el navegador.

## Características

- **Métricas en tiempo real** — voltaje, corriente, potencia, energía acumulada (Wh), capacidad (mAh), temperatura y líneas D+/D−
- **Detección de protocolo** — identifica automáticamente USB 5V, QC 9V/12V, PD 15V/20V y cargadores Apple
- **Gráfico interactivo** — series V/A/W toggleables, ventana de tiempo (30s/1m/5m/todo), zoom con rueda del ratón y exportación a PNG
- **Historial de sesiones** — cada sesión se guarda en SQLite con duración, Wh, mAh, W pico y W media
- **Comparar sesiones** — superpone dos sesiones en el gráfico para comparar cargadores o cables
- **Exportar a CSV** — descarga cualquier sesión histórica directamente desde la base de datos
- **Resumen al desconectar** — modal con las estadísticas de la sesión recién terminada

## Requisitos

- Python 3.9+
- FNIRSI FNB58 conectado por USB
- Linux (requiere permisos de acceso al dispositivo HID)

## Instalación

```bash
git clone https://github.com/TU_USUARIO/fnb58-monitor.git
cd fnb58-monitor
python -m venv venv
source venv/bin/activate
pip install flask flask-socketio pyusb
```

Para acceder al dispositivo sin `sudo`, añade una regla udev:

```bash
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="2e3c", ATTRS{idProduct}=="5558", MODE="0666"' \
  | sudo tee /etc/udev/rules.d/99-fnb58.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

## Uso

```bash
source venv/bin/activate
python app.py
```

Abre el navegador en `http://localhost:5000`, pulsa **Conectar** y empieza a medir.

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Python · Flask · Flask-SocketIO |
| Protocolo USB | PyUSB (interfaz HID del FNB58) |
| Base de datos | SQLite (WAL mode) |
| Frontend | Chart.js · Socket.IO · CSS puro |

## Licencia

MIT © 2026 Mateo Galdo
