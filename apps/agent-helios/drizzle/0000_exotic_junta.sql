CREATE TABLE `helios_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_id` text NOT NULL,
	`design_session_id` text NOT NULL,
	`modality` text NOT NULL,
	`status` text NOT NULL,
	`user_prompt` text NOT NULL,
	`planner_params` text NOT NULL,
	`image_r2_key` text,
	`cost_usd` real,
	`model_metadata` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer
);
