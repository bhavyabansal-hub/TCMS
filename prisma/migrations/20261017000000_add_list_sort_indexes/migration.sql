-- List-sort and queue-lookup indexes (performance audit 2026-10-17).
-- Every column used in a list ORDER BY or a queue WHERE now has an index.

-- CreateIndex
CREATE INDEX `test_cases_updated_at_idx` ON `test_cases`(`updated_at`);

-- CreateIndex
CREATE INDEX `test_case_history_test_case_id_version_idx` ON `test_case_history`(`test_case_id`, `version`);

-- CreateIndex
CREATE INDEX `module_review_requests_reviewer_id_status_created_at_idx` ON `module_review_requests`(`reviewer_id`, `status`, `created_at`);

-- CreateIndex
CREATE INDEX `module_review_requests_created_at_idx` ON `module_review_requests`(`created_at`);

-- CreateIndex
CREATE INDEX `review_requests_reviewer_id_status_created_at_idx` ON `review_requests`(`reviewer_id`, `status`, `created_at`);

-- CreateIndex
CREATE INDEX `review_requests_created_at_idx` ON `review_requests`(`created_at`);

-- CreateIndex
CREATE INDEX `bugs_created_at_idx` ON `bugs`(`created_at`);

-- CreateIndex
CREATE INDEX `bugs_updated_at_idx` ON `bugs`(`updated_at`);

-- CreateIndex
CREATE INDEX `activity_logs_user_id_created_at_idx` ON `activity_logs`(`user_id`, `created_at`);
