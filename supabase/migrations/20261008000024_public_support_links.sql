-- Replace obsolete development seed destinations without overwriting custom support settings.
UPDATE public.app_settings
SET value = to_jsonb('support@anotto.app'::text)
WHERE key = 'support_email' AND value = to_jsonb('support@spendsapp.com'::text);
UPDATE public.app_settings
SET value = to_jsonb('https://anotto.app/#faq'::text)
WHERE key = 'faq_url' AND value = to_jsonb('https://spendsapp.com/faq'::text);
UPDATE public.app_settings
SET value = to_jsonb('https://anotto.app/#faq'::text)
WHERE key = 'automation_faq_url' AND value = to_jsonb('https://spendsapp.com/faq/automation'::text);
