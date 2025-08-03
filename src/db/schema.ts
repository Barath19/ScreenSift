
import { integer, sqliteTable, text, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

export const screenshots = sqliteTable("screenshots", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  filename: text("filename").notNull(),
  r2Key: text("r2_key").notNull().unique(),
  fileSize: integer("file_size").notNull(),
  mimeType: text("mime_type").notNull(),
  uploadedAt: integer("uploaded_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  analyzedAt: integer("analyzed_at", { mode: "timestamp" }),
  isImportant: integer("is_important", { mode: "boolean" }).default(false),
  confidenceScore: real("confidence_score"),
}, (t) => [
  index("screenshots_uploaded_at_idx").on(t.uploadedAt),
  index("screenshots_is_important_idx").on(t.isImportant),
  uniqueIndex("screenshots_r2_key_unique").on(t.r2Key),
]);

export const categories = sqliteTable("categories", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("categories_name_unique").on(t.name),
]);

export const screenshotCategories = sqliteTable("screenshot_categories", {
  screenshotId: text("screenshot_id").notNull().references(() => screenshots.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
  confidence: real("confidence"),
}, (t) => [
  index("screenshot_categories_screenshot_id_idx").on(t.screenshotId),
  index("screenshot_categories_category_id_idx").on(t.categoryId),
]);

export const analysisResults = sqliteTable("analysis_results", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  screenshotId: text("screenshot_id").notNull().references(() => screenshots.id, { onDelete: "cascade" }),
  analysisType: text("analysis_type").notNull(),
  resultData: text("result_data", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("analysis_results_screenshot_id_idx").on(t.screenshotId),
  index("analysis_results_created_at_idx").on(t.createdAt),
]);

export const screenshotsRelations = relations(screenshots, ({ many }) => ({
  screenshotCategories: many(screenshotCategories),
  analysisResults: many(analysisResults),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  screenshotCategories: many(screenshotCategories),
}));

export const screenshotCategoriesRelations = relations(screenshotCategories, ({ one }) => ({
  screenshot: one(screenshots, {
    fields: [screenshotCategories.screenshotId],
    references: [screenshots.id],
  }),
  category: one(categories, {
    fields: [screenshotCategories.categoryId],
    references: [categories.id],
  }),
}));

export const analysisResultsRelations = relations(analysisResults, ({ one }) => ({
  screenshot: one(screenshots, {
    fields: [analysisResults.screenshotId],
    references: [screenshots.id],
  }),
}));