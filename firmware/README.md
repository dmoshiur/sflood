# FloodGuard firmware (educational model)

These sketches demonstrate the **local** sensor/state-machine path in the project brief. They are not certified controls, do not target a real barrier, and must not be used for flood protection. Test on a guarded, low-voltage, shallow-water model only.

## ESP32 main controller

- Board: ESP32 WROOM DevKit. Libraries: ESP32 Arduino core and `ESP32Servo`.
- GPIO 25 → HC-SR04 TRIG; GPIO 34 ← Echo through a **1 kΩ series + 2 kΩ to GND** divider; GPIO 26 is an optional ADC1 sensor input.
- GPIO 18/19 → servo signal only; servo power uses its own suitably rated regulated 5 V supply. Share ground, but never route stall current through the ESP32 or backfeed 5 V to a GPIO.
- GPIO 27 → NPN buzzer driver; GPIO 4 senses a normally-closed E-stop loop; GPIO 13 is a local model reset button.
- Boot begins in `UNKNOWN`. A sensor fault holds barrier position; WARNING/CRITICAL raises and latches (the latch flag is stored across reboot); E-stop enters `FAULT`. Lowering is a local, deliberate reset, and only allowed below the safe exit threshold.

## ESP8266 sender-only node

- Board: NodeMCU ESP8266. D1 (GPIO5) → TRIG; D2 (GPIO4) ← a separate Echo divider; sensor ground and NodeMCU ground are common.
- Echo is 5 V. The divider is `ECHO → 1 kΩ → D2`, then `D2 → 2 kΩ → GND` (about 3.3 V). This sender has no actuator pins or barrier authority.
- Telemetry uses HTTPS, a device bearer key and a persistent sequence. Install a verified root CA; never use `setInsecure()` in real deployments.

## Local credentials and firmware setup

Copy each nearby `config.example.h` to `config.h`, fill local values, and keep `config.h` out of Git. Upload with the matching board package; monitor at 115200 baud for ESP32 and 74880/115200 baud for ESP8266 as selected in Arduino IDE. Never paste device keys, Wi-Fi credentials, or certificates into this repository.

The demo server accepts sensor telemetry but **never sends motor commands**. The ESP32 keeps the sensor/state-machine loop local and moves HTTPS delivery to a lower-priority background task with bounded request timeouts. Local model firmware remains responsible for its own state transitions. The web simulator only mutates its JSON preview fixture.

## Bench order

1. Inspect the tray, raised island, guide rails and splash-protected enclosure.
2. Verify the Echo divider with a meter before connecting a GPIO.
3. Test one unloaded servo rail with no water; set travel limits and physical end stops.
4. Verify the normally-closed latching E-stop cuts actuator power independently of firmware.
5. Test five smooth dry cycles on a single wall before fitting a second wall.
6. Test sensor timeout, Wi-Fi loss, reboot, latch and local reset. Keep the demo shallow and supervised.
