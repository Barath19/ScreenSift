import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from "ai";
import * as schema from "./db/schema";

type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  GOOGLE_AI_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Add CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Helper function to generate R2 key
function generateR2Key(filename: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const uuid = crypto.randomUUID();
  const ext = filename.split('.').pop() || 'jpg';
  return `screenshots/${year}/${month}/${uuid}.${ext}`;
}

// Helper function to analyze screenshot with Gemini
async function analyzeScreenshot(imageBuffer: ArrayBuffer, env: Bindings) {
  const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_AI_API_KEY });
  
  // Convert to base64 without stack overflow for large images
  const uint8Array = new Uint8Array(imageBuffer);
  let binaryString = '';
  const chunkSize = 8192;
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.slice(i, i + chunkSize);
    binaryString += String.fromCharCode(...chunk);
  }
  const base64Image = btoa(binaryString);
  
  const analysisSchema = z.object({
    isImportant: z.boolean().describe("Whether this screenshot contains important information"),
    confidence: z.number().min(0).max(1).describe("Confidence score for the importance classification"),
    categories: z.array(z.string()).describe("Categories this screenshot belongs to"),
    description: z.string().describe("Brief description of the screenshot content"),
    extractedText: z.string().describe("ALL text visible in the screenshot via OCR"),
    contentType: z.enum(["dev", "social", "documents", "bugs", "temp", "other"]).describe("Primary content type based on classification rules"),
    folderCategory: z.enum(["Dev", "Social", "Documents", "Bugs", "Temp"]).describe("Folder to organize screenshot into"),
    retentionPolicy: z.enum(["keep", "delete_7_days", "delete_immediately"]).describe("How long to keep this screenshot"),
    importanceLevel: z.enum(["critical", "high", "medium", "low"]).describe("Importance level for prioritization")
  });

  try {
    const result = await generateObject({
      model: google("gemini-2.5-flash"),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this screenshot and classify it according to these rules:

CLASSIFICATION RULES:
- Code/terminal screenshots → Category: "Dev", Keep permanently
- Memes/social media → Category: "Social", Delete after 7 days  
- Important docs/receipts → Category: "Documents", Keep permanently
- Error messages/bugs → Category: "Bugs", Keep permanently
- Temporary/junk content → Category: "Temp", Delete immediately
- Screenshots with text → Extract all text via OCR and categorize appropriately

INSTRUCTIONS:
1. Extract ALL visible text from the screenshot
2. Classify the screenshot type based on content
3. Determine retention policy (keep/delete/7-day expiry)
4. Set importance level (critical for docs/receipts, high for dev/bugs, low for social/temp)
5. Assign appropriate folder category

Be thorough in text extraction and accurate in classification.`
            },
            {
              type: "image",
              image: `data:image/jpeg;base64,${base64Image}`
            }
          ]
        }
      ],
      schema: analysisSchema
    });

    return result.object;
  } catch (error) {
    console.error("Gemini analysis failed:", error);
    return {
      isImportant: false,
      confidence: 0.5,
      categories: ["uncategorized"],
      description: "Analysis failed",
      extractedText: "Analysis failed - could not extract text",
      contentType: "other" as const,
      folderCategory: "Temp" as const,
      retentionPolicy: "delete_immediately" as const,
      importanceLevel: "low" as const
    };
  }
}

// Upload screenshot endpoint
app.post("/upload", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    
    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file provided" }, 400);
    }

    if (!file.type.startsWith('image/')) {
      return c.json({ error: "File must be an image" }, 400);
    }

    const arrayBuffer = await file.arrayBuffer();
    const r2Key = generateR2Key(file.name);

    // Store in R2
    await c.env.R2.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type,
        cacheControl: 'max-age=86400'
      },
      customMetadata: {
        originalFilename: file.name,
        uploadedAt: new Date().toISOString()
      }
    });

    // Create screenshot record
    const [screenshot] = await db.insert(schema.screenshots).values({
      filename: file.name,
      r2Key: r2Key,
      fileSize: file.size,
      mimeType: file.type
    }).returning();

    // Analyze screenshot
    const analysis = await analyzeScreenshot(arrayBuffer, c.env);

    // Update screenshot with analysis results
    await db.update(schema.screenshots)
      .set({
        analyzedAt: new Date(),
        isImportant: analysis.isImportant,
        confidenceScore: analysis.confidence
      })
      .where(eq(schema.screenshots.id, screenshot.id));

    // Store analysis results
    await db.insert(schema.analysisResults).values({
      screenshotId: screenshot.id,
      analysisType: "gemini_vision",
      resultData: analysis
    });

    // Handle categories
    for (const categoryName of analysis.categories) {
      // Get or create category
      let [category] = await db.select()
        .from(schema.categories)
        .where(eq(schema.categories.name, categoryName));

      if (!category) {
        [category] = await db.insert(schema.categories)
          .values({ name: categoryName })
          .returning();
      }

      // Link screenshot to category
      await db.insert(schema.screenshotCategories).values({
        screenshotId: screenshot.id,
        categoryId: category.id,
        confidence: analysis.confidence
      });
    }

    return c.json({
      id: screenshot.id,
      filename: screenshot.filename,
      isImportant: analysis.isImportant,
      confidence: analysis.confidence,
      categories: analysis.categories,
      description: analysis.description
    }, 201);

  } catch (error) {
    console.error("Upload failed:", error);
    return c.json({ error: "Upload failed" }, 500);
  }
});

// Get screenshot file
app.get("/screenshots/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');

  try {
    const [screenshot] = await db.select()
      .from(schema.screenshots)
      .where(eq(schema.screenshots.id, id));

    if (!screenshot) {
      return c.json({ error: "Screenshot not found" }, 404);
    }

    const object = await c.env.R2.get(screenshot.r2Key);
    
    if (!object) {
      return c.json({ error: "File not found in storage" }, 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    return new Response(object.body, { headers });

  } catch (error) {
    console.error("Failed to retrieve screenshot:", error);
    return c.json({ error: "Failed to retrieve screenshot" }, 500);
  }
});

// Get screenshot analysis
app.get("/screenshots/:id/analysis", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');

  try {
    const [screenshot] = await db.select()
      .from(schema.screenshots)
      .where(eq(schema.screenshots.id, id));

    if (!screenshot) {
      return c.json({ error: "Screenshot not found" }, 404);
    }

    const analysisResults = await db.select()
      .from(schema.analysisResults)
      .where(eq(schema.analysisResults.screenshotId, id))
      .orderBy(desc(schema.analysisResults.createdAt));

    const categories = await db.select({
      name: schema.categories.name,
      confidence: schema.screenshotCategories.confidence
    })
      .from(schema.screenshotCategories)
      .innerJoin(schema.categories, eq(schema.screenshotCategories.categoryId, schema.categories.id))
      .where(eq(schema.screenshotCategories.screenshotId, id));

    return c.json({
      screenshot: {
        id: screenshot.id,
        filename: screenshot.filename,
        isImportant: screenshot.isImportant,
        confidenceScore: screenshot.confidenceScore,
        analyzedAt: screenshot.analyzedAt
      },
      categories,
      analysisResults
    });

  } catch (error) {
    console.error("Failed to get analysis:", error);
    return c.json({ error: "Failed to get analysis" }, 500);
  }
});

// Reanalyze screenshot
app.post("/screenshots/:id/reanalyze", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');

  try {
    const [screenshot] = await db.select()
      .from(schema.screenshots)
      .where(eq(schema.screenshots.id, id));

    if (!screenshot) {
      return c.json({ error: "Screenshot not found" }, 404);
    }

    const object = await c.env.R2.get(screenshot.r2Key);
    
    if (!object) {
      return c.json({ error: "File not found in storage" }, 404);
    }

    const arrayBuffer = await object.arrayBuffer();
    const analysis = await analyzeScreenshot(arrayBuffer, c.env);

    // Update screenshot with new analysis
    await db.update(schema.screenshots)
      .set({
        analyzedAt: new Date(),
        isImportant: analysis.isImportant,
        confidenceScore: analysis.confidence
      })
      .where(eq(schema.screenshots.id, id));

    // Store new analysis results
    await db.insert(schema.analysisResults).values({
      screenshotId: id,
      analysisType: "gemini_vision_reanalysis",
      resultData: analysis
    });

    // Clear old categories and add new ones
    await db.delete(schema.screenshotCategories)
      .where(eq(schema.screenshotCategories.screenshotId, id));

    for (const categoryName of analysis.categories) {
      let [category] = await db.select()
        .from(schema.categories)
        .where(eq(schema.categories.name, categoryName));

      if (!category) {
        [category] = await db.insert(schema.categories)
          .values({ name: categoryName })
          .returning();
      }

      await db.insert(schema.screenshotCategories).values({
        screenshotId: id,
        categoryId: category.id,
        confidence: analysis.confidence
      });
    }

    return c.json({
      message: "Reanalysis completed",
      isImportant: analysis.isImportant,
      confidence: analysis.confidence,
      categories: analysis.categories
    });

  } catch (error) {
    console.error("Reanalysis failed:", error);
    return c.json({ error: "Reanalysis failed" }, 500);
  }
});

// List screenshots with filtering
app.get("/screenshots", async (c) => {
  const db = drizzle(c.env.DB);
  
  const category = c.req.query('category');
  const importantOnly = c.req.query('important_only') === 'true';
  const limit = Number.parseInt(c.req.query('limit') || '50');
  const offset = Number.parseInt(c.req.query('offset') || '0');
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');

  try {
    const conditions = [];
    
    if (importantOnly) {
      conditions.push(eq(schema.screenshots.isImportant, true));
    }
    
    if (dateFrom) {
      conditions.push(gte(schema.screenshots.uploadedAt, new Date(dateFrom)));
    }
    
    if (dateTo) {
      conditions.push(lte(schema.screenshots.uploadedAt, new Date(dateTo)));
    }

    let query = db.select({
      id: schema.screenshots.id,
      filename: schema.screenshots.filename,
      fileSize: schema.screenshots.fileSize,
      mimeType: schema.screenshots.mimeType,
      uploadedAt: schema.screenshots.uploadedAt,
      analyzedAt: schema.screenshots.analyzedAt,
      isImportant: schema.screenshots.isImportant,
      confidenceScore: schema.screenshots.confidenceScore
    }).from(schema.screenshots);

    if (category) {
      const screenshotsWithCategory = await db.select({
        id: schema.screenshots.id,
        filename: schema.screenshots.filename,
        fileSize: schema.screenshots.fileSize,
        mimeType: schema.screenshots.mimeType,
        uploadedAt: schema.screenshots.uploadedAt,
        analyzedAt: schema.screenshots.analyzedAt,
        isImportant: schema.screenshots.isImportant,
        confidenceScore: schema.screenshots.confidenceScore
      })
        .from(schema.screenshots)
        .innerJoin(schema.screenshotCategories, eq(schema.screenshots.id, schema.screenshotCategories.screenshotId))
        .innerJoin(schema.categories, eq(schema.screenshotCategories.categoryId, schema.categories.id))
        .where(and(eq(schema.categories.name, category), ...conditions))
        .orderBy(desc(schema.screenshots.uploadedAt))
        .limit(limit)
        .offset(offset);
      
      return c.json({ screenshots: screenshotsWithCategory, limit, offset });
    } else if (conditions.length > 0) {
      const filteredScreenshots = await query
        .where(and(...conditions))
        .orderBy(desc(schema.screenshots.uploadedAt))
        .limit(limit)
        .offset(offset);
      
      return c.json({ screenshots: filteredScreenshots, limit, offset });
    }

    const screenshots = await query
      .orderBy(desc(schema.screenshots.uploadedAt))
      .limit(limit)
      .offset(offset);

    return c.json({ screenshots, limit, offset });

  } catch (error) {
    console.error("Failed to list screenshots:", error);
    return c.json({ error: "Failed to list screenshots" }, 500);
  }
});

// List categories
app.get("/categories", async (c) => {
  const db = drizzle(c.env.DB);

  try {
    const categories = await db.select({
      id: schema.categories.id,
      name: schema.categories.name,
      description: schema.categories.description,
      createdAt: schema.categories.createdAt,
      screenshotCount: sql<number>`count(${schema.screenshotCategories.screenshotId})`
    })
      .from(schema.categories)
      .leftJoin(schema.screenshotCategories, eq(schema.categories.id, schema.screenshotCategories.categoryId))
      .groupBy(schema.categories.id);

    return c.json({ categories });

  } catch (error) {
    console.error("Failed to list categories:", error);
    return c.json({ error: "Failed to list categories" }, 500);
  }
});

// Delete screenshot
app.delete("/screenshots/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');

  try {
    const [screenshot] = await db.select()
      .from(schema.screenshots)
      .where(eq(schema.screenshots.id, id));

    if (!screenshot) {
      return c.json({ error: "Screenshot not found" }, 404);
    }

    // Delete from R2
    await c.env.R2.delete(screenshot.r2Key);

    // Delete from database (cascading deletes will handle related records)
    await db.delete(schema.screenshots)
      .where(eq(schema.screenshots.id, id));

    return c.json({ message: "Screenshot deleted successfully" });

  } catch (error) {
    console.error("Failed to delete screenshot:", error);
    return c.json({ error: "Failed to delete screenshot" }, 500);
  }
});

// Create MCP server
function createMcpServer(env: Bindings) {
  const server = new McpServer({
    name: "screensift-mcp",
    version: "1.0.0",
    description: "AI-powered screenshot classification and organization system"
  });

  const db = drizzle(env.DB);

  // Analyze screenshot tool
  server.tool(
    "analyze_screenshot",
    {
      imageData: z.string().describe("Base64 encoded image data"),
      filename: z.string().describe("Original filename")
    },
    async ({ imageData, filename }) => {
      try {
        const buffer = Uint8Array.from(atob(imageData), c => c.charCodeAt(0)).buffer;
        const r2Key = generateR2Key(filename);

        // Store in R2
        await env.R2.put(r2Key, buffer, {
          httpMetadata: {
            contentType: 'image/jpeg',
            cacheControl: 'max-age=86400'
          }
        });

        // Create screenshot record
        const [screenshot] = await db.insert(schema.screenshots).values({
          filename,
          r2Key,
          fileSize: buffer.byteLength,
          mimeType: 'image/jpeg'
        }).returning();

        // Analyze
        const analysis = await analyzeScreenshot(buffer, env);

        // Update with analysis
        await db.update(schema.screenshots)
          .set({
            analyzedAt: new Date(),
            isImportant: analysis.isImportant,
            confidenceScore: analysis.confidence
          })
          .where(eq(schema.screenshots.id, screenshot.id));

        return {
          content: [{
            type: "text",
            text: `Screenshot analyzed successfully:
ID: ${screenshot.id}
Important: ${analysis.isImportant}
Confidence: ${analysis.confidence}
Categories: ${analysis.categories.join(', ')}
Description: ${analysis.description}`
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Search screenshots tool
  server.tool(
    "search_screenshots",
    {
      category: z.string().optional().describe("Filter by category"),
      importantOnly: z.boolean().default(false).describe("Show only important screenshots"),
      limit: z.number().default(10).describe("Maximum number of results")
    },
    async ({ category, importantOnly, limit }) => {
      try {
        const conditions = [];
        
        if (importantOnly) {
          conditions.push(eq(schema.screenshots.isImportant, true));
        }

        let query = db.select().from(schema.screenshots);

        if (category) {
          const screenshotsWithCategory = await db.select()
            .from(schema.screenshots)
            .innerJoin(schema.screenshotCategories, eq(schema.screenshots.id, schema.screenshotCategories.screenshotId))
            .innerJoin(schema.categories, eq(schema.screenshotCategories.categoryId, schema.categories.id))
            .where(and(eq(schema.categories.name, category), ...conditions))
            .orderBy(desc(schema.screenshots.uploadedAt))
            .limit(limit);
          
          const screenshots = screenshotsWithCategory.map(row => row.screenshots);
          
          const results = screenshots.map(s => 
            `ID: ${s.id} | ${s.filename} | Important: ${s.isImportant} | Uploaded: ${s.uploadedAt}`
          ).join('\\n');

          return {
            content: [{
              type: "text",
              text: `Found ${screenshots.length} screenshots:\\n${results}`
            }]
          };
        } else if (conditions.length > 0) {
          const screenshots = await query
            .where(and(...conditions))
            .orderBy(desc(schema.screenshots.uploadedAt))
            .limit(limit);
          
          const results = screenshots.map(s => 
            `ID: ${s.id} | ${s.filename} | Important: ${s.isImportant} | Uploaded: ${s.uploadedAt}`
          ).join('\\n');

          return {
            content: [{
              type: "text",
              text: `Found ${screenshots.length} screenshots:\\n${results}`
            }]
          };
        }

        const screenshots = await query
          .orderBy(desc(schema.screenshots.uploadedAt))
          .limit(limit);

        const results = screenshots.map(s => 
          `ID: ${s.id} | ${s.filename} | Important: ${s.isImportant} | Uploaded: ${s.uploadedAt}`
        ).join('\n');

        return {
          content: [{
            type: "text",
            text: `Found ${screenshots.length} screenshots:\n${results}`
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Cleanup clutter tool
  server.tool(
    "cleanup_clutter",
    {
      dryRun: z.boolean().default(true).describe("Preview deletions without actually deleting"),
      confidenceThreshold: z.number().default(0.8).describe("Minimum confidence to consider for deletion")
    },
    async ({ dryRun, confidenceThreshold }) => {
      try {
        const clutterScreenshots = await db.select()
          .from(schema.screenshots)
          .where(and(
            eq(schema.screenshots.isImportant, false),
            gte(schema.screenshots.confidenceScore, confidenceThreshold)
          ));

        if (dryRun) {
          const preview = clutterScreenshots.map(s => 
            `${s.filename} (Confidence: ${s.confidenceScore})`
          ).join('\n');

          return {
            content: [{
              type: "text",
              text: `Found ${clutterScreenshots.length} screenshots that could be deleted:\n${preview}`
            }]
          };
        }

        // Actually delete
        let deletedCount = 0;
        for (const screenshot of clutterScreenshots) {
          await env.R2.delete(screenshot.r2Key);
          await db.delete(schema.screenshots)
            .where(eq(schema.screenshots.id, screenshot.id));
          deletedCount++;
        }

        return {
          content: [{
            type: "text",
            text: `Successfully deleted ${deletedCount} clutter screenshots`
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Get screenshot stats tool
  server.tool(
    "get_screenshot_stats",
    {},
    async () => {
      try {
        const [totalCount] = await db.select({ count: sql<number>`count(*)` })
          .from(schema.screenshots);

        const [importantCount] = await db.select({ count: sql<number>`count(*)` })
          .from(schema.screenshots)
          .where(eq(schema.screenshots.isImportant, true));

        const [totalSize] = await db.select({ size: sql<number>`sum(${schema.screenshots.fileSize})` })
          .from(schema.screenshots);

        const categories = await db.select({
          name: schema.categories.name,
          count: sql<number>`count(${schema.screenshotCategories.screenshotId})`
        })
          .from(schema.categories)
          .leftJoin(schema.screenshotCategories, eq(schema.categories.id, schema.screenshotCategories.categoryId))
          .groupBy(schema.categories.id)
          .orderBy(desc(sql<number>`count(${schema.screenshotCategories.screenshotId})`));

        const categoryStats = categories.map(c => `${c.name}: ${c.count}`).join('\n');

        return {
          content: [{
            type: "text",
            text: `Screenshot Statistics:
Total Screenshots: ${totalCount.count}
Important Screenshots: ${importantCount.count}
Total Storage Used: ${Math.round((totalSize.size || 0) / 1024 / 1024)} MB

Category Breakdown:
${categoryStats}`
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to get stats: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  return server;
}

// MCP endpoint
app.all("/mcp", async (c) => {
  const mcpServer = createMcpServer(c.env);
  const transport = new StreamableHTTPTransport();
  
  await mcpServer.connect(transport);
  return transport.handleRequest(c);
});

app.get("/", (c) => {
  return c.text("ScreenSift MCP - AI-powered screenshot classification system");
});

app.get("/openapi.json", c => {
  return c.json(createOpenAPISpec(app, {
    info: {
      title: "ScreenSift MCP API",
      version: "1.0.0",
      description: "AI-powered screenshot classification and organization system"
    },
  }))
});

app.use("/fp/*", createFiberplane({
  app,
  openapi: { url: "/openapi.json" }
}));

export default app;