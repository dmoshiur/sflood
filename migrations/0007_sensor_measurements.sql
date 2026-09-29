-- Store only measurements actually transmitted by the controller.
ALTER TABLE telemetry ADD COLUMN distance_cm REAL;
ALTER TABLE telemetry ADD COLUMN temperature_c REAL;
