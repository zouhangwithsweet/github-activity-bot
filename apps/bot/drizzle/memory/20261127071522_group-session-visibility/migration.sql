CREATE TABLE `__new_private_group_sessions` (
	`scope` text NOT NULL,
	`native_id` text NOT NULL,
	CONSTRAINT `private_group_sessions_pk` PRIMARY KEY(`scope`, `native_id`)
) STRICT;
--> statement-breakpoint
-- Legacy flags have no reason recorded. Carry them forward on the native history they protected.
INSERT INTO `__new_private_group_sessions`(`scope`, `native_id`)
SELECT p.`scope`, coalesce(s.`native_id`, '') FROM `private_group_sessions` p
LEFT JOIN `sessions` s ON s.`scope` = p.`scope`;--> statement-breakpoint
DROP TABLE `private_group_sessions`;--> statement-breakpoint
ALTER TABLE `__new_private_group_sessions` RENAME TO `private_group_sessions`;--> statement-breakpoint
CREATE TABLE `__new_group_repositories` (
	`scope` text NOT NULL,
	`native_id` text NOT NULL,
	`repository` text NOT NULL,
	CONSTRAINT `group_repositories_pk` PRIMARY KEY(`scope`, `native_id`, `repository`)
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_group_repositories`(`scope`, `native_id`, `repository`)
SELECT r.`scope`, coalesce(s.`native_id`, ''), r.`repository` FROM `group_repositories` r
LEFT JOIN `sessions` s ON s.`scope` = r.`scope`;--> statement-breakpoint
DROP TABLE `group_repositories`;--> statement-breakpoint
ALTER TABLE `__new_group_repositories` RENAME TO `group_repositories`;--> statement-breakpoint
CREATE INDEX `group_anchors_by_topic` ON `group_anchors` (`chat_id`,`session_key`);
