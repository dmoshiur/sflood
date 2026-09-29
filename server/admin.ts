import { z } from 'zod';
import { ownerRouter, requireCsrf, requireOwner } from './auth.js';
import { insertAudit } from './database.js';
import { getSavedProvider, providerSummary, recordProviderTest, saveProvider, validateProviderInput, verifySmsProvider, verifySmtpProvider, sendEmail } from './providers.js';

const smtpInput = z.object({ host: z.string().trim().min(1).max(255), port: z.coerce.number().int().min(1).max(65535), secure: z.boolean(), username: z.string().trim().max(255).optional().default(''), password: z.string().max(1024).optional().default(''), fromName: z.string().trim().min(1).max(100), fromAddress: z.string().email().max(254), replyTo: z.string().email().max(254).or(z.literal('')).optional().default(''), enabled: z.boolean() });
const smsInput = z.object({ endpoint: z.string().url().max(2048), authHeader: z.string().trim().max(64).optional().default('Authorization'), authPrefix: z.string().max(40).optional().default('Bearer '), authToken: z.string().max(2048).optional().default(''), senderId: z.string().max(64).optional().default(''), toField: z.string().trim().max(48).optional().default('to'), messageField: z.string().trim().max(48).optional().default('message'), senderField: z.string().trim().max(48).optional().default('sender'), enabled: z.boolean() });

ownerRouter.get('/providers', requireOwner, async (_req, res, next) => {
  try { res.json({ providers: await providerSummary() }); }
  catch (error) { next(error); }
});

ownerRouter.put('/providers/smtp', requireOwner, requireCsrf, async (req, res, next) => {
  const parsed = smtpInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid SMTP settings.' }); return; }
  const user = res.locals.authUser as { id: string; tenantId: string };
  try {
    const previous = await getSavedProvider('SMTP');
    const config = validateProviderInput('SMTP', parsed.data, previous?.config) as Parameters<typeof saveProvider>[1];
    await saveProvider('SMTP', config, parsed.data.enabled, user.id);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SMTP_PROVIDER_UPDATED', targetType: 'provider', targetId: 'SMTP', metadata: { host: parsed.data.host, port: parsed.data.port, enabled: parsed.data.enabled }, ipAddress: req.ip });
    res.json({ saved: true, providers: await providerSummary(), message: 'SMTP credentials were encrypted before storage. Saved secrets are never returned to the browser.' });
  } catch (error) { next(error); }
});

ownerRouter.put('/providers/sms', requireOwner, requireCsrf, async (req, res, next) => {
  const parsed = smsInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid SMS gateway settings.' }); return; }
  const user = res.locals.authUser as { id: string; tenantId: string };
  try {
    const previous = await getSavedProvider('SMS_HTTP');
    const config = validateProviderInput('SMS_HTTP', parsed.data, previous?.config) as Parameters<typeof saveProvider>[1];
    await saveProvider('SMS_HTTP', config, parsed.data.enabled, user.id);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SMS_PROVIDER_UPDATED', targetType: 'provider', targetId: 'SMS_HTTP', metadata: { endpointHost: new URL(parsed.data.endpoint).host, enabled: parsed.data.enabled }, ipAddress: req.ip });
    res.json({ saved: true, providers: await providerSummary(), message: 'SMS gateway credentials were encrypted before storage. Saved secrets are never returned to the browser.' });
  } catch (error) { next(error); }
});

ownerRouter.post('/providers/smtp/test', requireOwner, requireCsrf, async (req, res, next) => {
  const parsed = z.object({ recipient: z.string().email().max(254).optional(), confirmSend: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Confirm the test and enter a valid optional recipient email address.' }); return; }
  const user = res.locals.authUser as { id: string; tenantId: string };
  try {
    await verifySmtpProvider();
    let summary = 'SMTP connection verified';
    if (parsed.data.recipient) {
      await sendEmail(parsed.data.recipient, { title: 'FloodGuard SMTP settings test', body: 'This is a test message requested from the protected Hackeradmin console. No flood alert is active.' });
      summary = `test message delivered to ${parsed.data.recipient}`;
    }
    await recordProviderTest('SMTP', true, summary);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SMTP_PROVIDER_TESTED', targetType: 'provider', targetId: 'SMTP', metadata: { recipientProvided: Boolean(parsed.data.recipient) }, ipAddress: req.ip });
    res.json({ success: true, message: summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SMTP connection failed.';
    await recordProviderTest('SMTP', false, message).catch(() => undefined);
    next(error);
  }
});

ownerRouter.post('/providers/sms/test', requireOwner, requireCsrf, async (req, res, next) => {
  const parsed = z.object({ recipient: z.string().regex(/^\+[1-9]\d{7,14}$/), confirmSend: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Confirm the paid test SMS and enter a phone number in E.164 format.' }); return; }
  const user = res.locals.authUser as { id: string; tenantId: string };
  try {
    await verifySmsProvider(parsed.data.recipient);
    await recordProviderTest('SMS_HTTP', true, `test SMS sent to ${parsed.data.recipient}`);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SMS_PROVIDER_TESTED', targetType: 'provider', targetId: 'SMS_HTTP', metadata: { destination: parsed.data.recipient }, ipAddress: req.ip });
    res.json({ success: true, message: `Test request accepted for ${parsed.data.recipient}. Check the provider delivery report.` });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SMS gateway test failed.';
    await recordProviderTest('SMS_HTTP', false, message).catch(() => undefined);
    next(error);
  }
});
