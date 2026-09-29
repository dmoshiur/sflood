-- Default service-area allowlist for the science-fair deployment.
-- Super admins can add, disable or remove rows through the admin console.

INSERT INTO service_areas(id,country_code,country_name,city_name,enabled,created_at) VALUES
  ('sa-dhaka','BD','Bangladesh','Dhaka',1,datetime('now')),
  ('sa-chattogram','BD','Bangladesh','Chattogram',1,datetime('now')),
  ('sa-khulna','BD','Bangladesh','Khulna',1,datetime('now')),
  ('sa-rajshahi','BD','Bangladesh','Rajshahi',1,datetime('now')),
  ('sa-sylhet','BD','Bangladesh','Sylhet',1,datetime('now')),
  ('sa-rangpur','BD','Bangladesh','Rangpur',1,datetime('now')),
  ('sa-barishal','BD','Bangladesh','Barishal',1,datetime('now')),
  ('sa-mymensingh','BD','Bangladesh','Mymensingh',1,datetime('now'))
ON CONFLICT(country_code, city_name) DO NOTHING;

-- Default flood-engine / automation policy settings (JSON). Editable in admin.
INSERT INTO site_settings(key,value_json,updated_at) VALUES
  ('flood_engine_config','{"watchCm":20,"warningCm":35,"criticalCm":50,"recoveryCm":15,"hysteresisCm":3,"rateOfRiseWarningCmPerMin":2.5,"rateOfRiseCriticalCmPerMin":6,"recoveryCooldownSeconds":300,"stateCooldownSeconds":60,"duplicateEventWindowSeconds":900,"multiSensorConfirmations":1,"multiSensorWindowSeconds":120}',datetime('now')),
  ('automation_policy','{"autoBarrierOnWarning":true,"autoBarrierOnCritical":true,"autoLowerOnRecovery":false,"notifyEmailOnCritical":true,"notifySmsOnCritical":true,"notifyPushOnWarning":true,"notifyOnRecovery":true}',datetime('now')),
  ('feature_flags','{"simulationMode":true,"publicStatusPage":true,"emailSubscriptions":true,"pushNotifications":true,"siteEditor":true,"deviceProvisioning":true,"opsConsole":true}',datetime('now')),
  ('site_status','{"emergency":false,"message":""}',datetime('now'))
ON CONFLICT(key) DO NOTHING;
