CREATE TABLE `analysis_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`screenshot_id` text NOT NULL,
	`analysis_type` text NOT NULL,
	`result_data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`screenshot_id`) REFERENCES `screenshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analysis_results_screenshot_id_idx` ON `analysis_results` (`screenshot_id`);--> statement-breakpoint
CREATE INDEX `analysis_results_created_at_idx` ON `analysis_results` (`created_at`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `screenshot_categories` (
	`screenshot_id` text NOT NULL,
	`category_id` integer NOT NULL,
	`confidence` real,
	FOREIGN KEY (`screenshot_id`) REFERENCES `screenshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `screenshot_categories_screenshot_id_idx` ON `screenshot_categories` (`screenshot_id`);--> statement-breakpoint
CREATE INDEX `screenshot_categories_category_id_idx` ON `screenshot_categories` (`category_id`);--> statement-breakpoint
CREATE TABLE `screenshots` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`r2_key` text NOT NULL,
	`file_size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`analyzed_at` integer,
	`is_important` integer DEFAULT false,
	`confidence_score` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `screenshots_r2_key_unique` ON `screenshots` (`r2_key`);--> statement-breakpoint
CREATE INDEX `screenshots_uploaded_at_idx` ON `screenshots` (`uploaded_at`);--> statement-breakpoint
CREATE INDEX `screenshots_is_important_idx` ON `screenshots` (`is_important`);