# Wiring and calibration guide

Reference wiring for the FloodGrid miniature-city prototype. This is an
educational build: low voltage, a model barrier and a tabletop water tray.
**Never connect this to real flood infrastructure.**

## 1. Bill of materials

| Part | Notes |
| --- | --- |
| ESP32-WROOM-32 dev board | Controller. Any 30+ pin dev board works. |
| ESP8266 NodeMCU / Wemos D1 mini | Optional second (sender) node. |
| HC-SR04 ultrasonic sensor | Water level. Works through air; keep it dry. |
| SG90 or MG996R servo | Model barrier actuator. |
| 1 kΩ and 2 kΩ resistors | Echo divider (or a logic level shifter). |
| 5 V 2 A regulated supply | Separate rail for the servo. |
| Limit switches (2) | Mechanical, normally open, close at each end stop. |
| Latching emergency stop, NC | In series with the actuator power rail. |
| NPN transistor + buzzer or LED | Optional local alert; never drive a buzzer from a GPIO. |
| Perfboard, jumper wires, tray, model city | Structure. |

## 2. ESP32 pin map

Matches `firmware/esp32-main/esp32-main.ino`.

| GPIO | Function | Direction | Notes |
| --- | --- | --- | --- |
| 25 | `TRIG` | output | HC-SR04 trigger. 3.3 V logic, safe. |
| 34 | `ECHO` | **input only** | Through the divider below. Input-only pin, no pull-up. |
| 18 | Servo signal | output | Signal only. The servo gets its own 5 V rail. |
| 32 | Limit switch, barrier down | input pull-up | Closes to GND at the down end stop. |
| 33 | Limit switch, barrier up | input pull-up | Closes to GND at the up end stop. |
| 4 | Emergency stop sense | input pull-up | NC contact to GND. Open = stop. |
| 13 | Local reset button | input pull-up | Momentary to GND. |
| 2 | Status LED | output | On-board LED; on when state ≥ WARNING. |

GPIO 34, 32 and 33 are all safe choices on a WROOM-32: 34 is input-only (fine
for the echo) and 32/33 are ADC1 pins, which keep working while Wi-Fi is on
(unlike ADC2).

## 3. Sensor

```
HC-SR04 VCC  -> 5 V rail
HC-SR04 GND  -> common ground
HC-SR04 TRIG -> GPIO 25
HC-SR04 ECHO -> 1 kΩ -> GPIO 34
                   |
                  2 kΩ
                   |
                  GND
```

The echo pin is a 5 V open-drain output. The divider drops it to about 3.3 V,
which is what the ESP32 tolerates. Use a proper level shifter if you prefer;
never connect the echo pin straight to a GPIO.

Mount the sensor above the lowest expected water line, facing straight down at
a still surface. Keep it out of splash and out of direct sunlight, and keep the
tray walls out of the cone: the HC-SR04 beam is roughly 15° wide, so a narrow
tray can produce a false short echo.

## 4. Actuator and safety chain

```
5 V 2 A supply + ---[latching E-stop, NC]---+
                                            |
                                      servo VCC (red)
                                      (buzzer driver, if fitted)
5 V supply - ------------------------- common GND with the ESP32
ESP32 GPIO 18 ------------------------ servo signal (orange)
```

- The servo power comes from its own regulated 5 V rail, never from the ESP32's
  3.3 V regulator.
- The emergency stop is a **normally closed** contact wired in series with the
  actuator power. Opening it removes actuator power no matter what any software
  says. GPIO 4 only *senses* the same contact so the controller can report
  `EMERGENCY_STOP` and refuse to move.
- Both limit switches are normally open and close to GND at the end stops. The
  firmware stops driving the servo as soon as the switch for the target position
  closes, and gives up after a 15 s actuator timeout.
- A buzzer or indicator LED goes through an NPN transistor, never straight from
  a GPIO.

## 5. Power-up checklist

1. With the supply off, verify every ground is common and the servo rail is
   separate.
2. Confirm the divider resistors before connecting the echo pin.
3. Power the ESP32 only. Open the serial monitor and confirm it boots and
   reports `sensorHealthy` without moving the barrier.
4. Power the servo rail. Confirm the barrier moves to the down end stop and the
   low limit switch closes.
5. Press the emergency stop. The barrier must stop, and the firmware must report
   `barrier=FAULT` with `emergencyStopActive=true`.
6. Release and reset the fault locally. Only then continue.

## 6. Calibration

The firmware converts a distance reading into a water level:

```
level_cm = SENSOR_ZERO_CM - measured_distance_cm + LEVEL_OFFSET_CM
```

1. With the tray empty, put a ruler from the sensor face to the tray floor.
   That distance is `SENSOR_ZERO_CM` (65 cm in the example).
2. Pour a known depth of water, e.g. 5 cm, and read the reported `levelCm`.
   Set `LEVEL_OFFSET_CM` to the difference. Re-check at two more depths.
3. Set the local thresholds to match the zone policy in the admin console
   (`WATCH_CM`, `WARNING_CM`, `CRITICAL_CM`, `HYSTERESIS_CM`, `RECOVERY_CM`).
   The controller keeps working on its own values if the network is down, so
   they must agree with the cloud policy.
4. Set the servo angles (`SERVO_DOWN_DEG`, `SERVO_UP_DEG`) so the barrier sits
   fully down and fully up without stalling against an end stop. A stalled SG90
   draws a lot of current and will brown out a weak supply.

## 7. Mechanical notes

- Keep the barrier light. A servo is not a winch; the model barrier should move
  with almost no load.
- Use a mechanical end stop rather than relying on servo torque.
- Route the sensor cable away from the servo cable to avoid noise on the echo.
- The tray should be able to be emptied quickly: most of this project's testing
  is pouring water in and out.

## 8. Failure modes the firmware handles

| Condition | Firmware behaviour |
| --- | --- |
| No valid echo | `sensorHealthy=false`, fault latched, barrier holds |
| Level above the critical threshold | State `CRITICAL`, barrier commanded up |
| Emergency stop open | Actuator power cut, `barrier=FAULT`, actuation inhibited |
| Limit switch never closes | Actuator timeout after 15 s, `barrier=FAULT` |
| Wi-Fi or API unreachable | Local state machine continues, telemetry resumes when the link returns |
| Command redelivered | Command id remembered in RAM, executed once |
