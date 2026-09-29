# Wiring guide — FloodGuard model hardware

Science-fair model only. Never connect model electronics to real flood-control infrastructure. Double-check the HC-SR04 Echo divider before power-up: the ESP8266 Echo pin is **not** 5 V tolerant.

## Safety first

1. Put a **normally-closed latching E-stop** in series with the servo power rail. GPIO sensing of the E-stop is supplementary; a software fault must never be able to move the barrier.
2. Servos run from a **separate regulated 5 V rail** (≥ 2 A) — never from the ESP32 5 V pin. Common ground with the MCU is required.
3. Keep the tray splash zone away from boards; conformal coat or bag the electronics.

## ESP32 main controller

| Signal | ESP32 pin | Notes |
| --- | --- | --- |
| HC-SR04 Trigger | GPIO 25 | 3.3 V logic is fine |
| HC-SR04 Echo | GPIO 34 | **1 kΩ series + 2 kΩ to GND divider** from the 5 V Echo line |
| Optional water ADC | GPIO 26 | ADC1; safe to leave disconnected |
| Servo left signal | GPIO 18 | Signal only — power from the 5 V rail |
| Servo right signal | GPIO 19 | Signal only |
| Buzzer driver | GPIO 27 | NPN transistor (2N2222/SS8050) + flyback diode; never drive a buzzer load directly |
| E-stop sense | GPIO 4 | NC contact to GND + internal `INPUT_PULLUP`; loop open = stop/fault |
| Local reset button | GPIO 13 | Momentary to 3.3 V + `INPUT_PULLDOWN`; hold 2 s to lower below the recovery threshold |
| Barrier limit switch (raised) | GPIO 32 | NC switch + `INPUT_PULLUP`; closes at the raised position |
| Barrier limit switch (lowered) | GPIO 33 | NC switch + `INPUT_PULLUP`; closes at the lowered position |

## ESP8266 sender node

| Signal | NodeMCU pin | Notes |
| --- | --- | --- |
| HC-SR04 Trigger | D1 (GPIO 5) | |
| HC-SR04 Echo | D2 (GPIO 4) | **1 kΩ series + 2 kΩ to GND divider** — mandatory |

The sender has **no** actuator pins and no command authority: it only reports telemetry.

## Power

```
mains → 5 V 3 A PSU → servo rail (E-stop NC contact in series)
                   ↘ buck 3.3 V → ESP32 / NodeMCU / sensors
common ground across every module
```

## Perimeter barrier

The model barrier is a lightweight servo-driven gate in the tray wall. With `SERVO_DOWN_DEG = 12` / `SERVO_UP_DEG = 92`, adjust to your geometry. The limit switches give the platform real actuator feedback (`OPEN`/`CLOSED`/`TRAVELING`/`UNKNOWN`) which is reported in telemetry and in command acknowledgements.
