-- oxy:deploy-phase=pre
-- Broaden accepted Oxy file event types before the new receiver handles permanent loss.
ALTER TABLE "merchant_avatar_audit" DROP CONSTRAINT "merchant_avatar_audit_event_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_events" DROP CONSTRAINT "oxy_file_events_event_type_check";--> statement-breakpoint
ALTER TABLE "merchant_avatar_audit" ADD CONSTRAINT "merchant_avatar_audit_event_type_check" CHECK (event_type in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked', 'file.lost'));--> statement-breakpoint
ALTER TABLE "oxy_file_events" ADD CONSTRAINT "oxy_file_events_event_type_check" CHECK (event_type in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked', 'file.lost'));