CREATE TABLE `prompts` (
	`id` integer PRIMARY KEY NOT NULL,
	`slot` text NOT NULL,
	`prompt_text` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_slot_unique` ON `prompts` (`slot`);