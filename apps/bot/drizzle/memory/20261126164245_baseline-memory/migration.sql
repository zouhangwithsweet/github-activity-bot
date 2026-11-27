-- Adopt the tables from the original SQLite bootstrap when they already exist.
CREATE TABLE IF NOT EXISTS `group_anchors` (
	`sequence` integer PRIMARY KEY,
	`chat_id` text NOT NULL,
	`anchor_key` text NOT NULL,
	`session_key` text NOT NULL,
	`thread_id` text,
	CONSTRAINT `group_anchors_chat_id_anchor_key_unique` UNIQUE(`chat_id`,`anchor_key`)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `group_repositories` (
	`scope` text NOT NULL,
	`repository` text NOT NULL,
	CONSTRAINT `group_repositories_pk` PRIMARY KEY(`scope`, `repository`)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `private_group_sessions` (
	`scope` text PRIMARY KEY
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`scope` text PRIMARY KEY,
	`native_id` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `group_anchors_by_chat` ON `group_anchors` (`chat_id`,"sequence" DESC);
