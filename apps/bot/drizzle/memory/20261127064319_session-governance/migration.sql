ALTER TABLE `sessions` ADD `last_used_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `creation_reason` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `reset_requested` integer DEFAULT false NOT NULL;