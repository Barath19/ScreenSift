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
import QrCode from 'qrcode-reader';
import Jimp from 'jimp';

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
    category: z.string().describe("Single primary category this screenshot belongs to"),
    description: z.string().describe("Brief description of the screenshot content"),
    extractedText: z.string().describe("ALL text visible in the screenshot via OCR"),
    contentType: z.enum(["dev", "social", "documents", "bugs", "temp", "secrets", "other"]).describe("Primary content type based on classification rules"),
    folderCategory: z.enum(["Dev", "Social", "Documents", "Bugs", "Temp", "Secrets"]).describe("Folder to organize screenshot into"),
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
- SENSITIVE/SECRET DATA → Category: "Secrets" (API keys, passwords, tokens, credentials, private keys, .env files)
- ERROR MESSAGES/RED TEXT → Category: "Bugs" (stack traces, error dialogs, failed commands, red terminal text, exceptions)
- IDE/CODE WORK → Category: "Dev" (VSCode, IDEs, successful builds, green terminal, working code, file explorers)
- Important docs/receipts → Category: "Documents", Keep permanently
- Memes/social media → Category: "Social", Delete after 7 days  
- Temporary/junk content → Category: "Temp", Delete immediately

CRITICAL PRIORITY ORDER:
1. SECRETS FIRST: If contains API keys, passwords, tokens, "secret", "key", "password", "token", "credential" → "Secrets"
2. BUGS: Red terminal text, error messages, stack traces, "error", "failed", "exception" → "Bugs"  
3. DEV: Green/normal terminal, IDEs, successful code, file trees → "Dev"

VISUAL INDICATORS:
- Red text/background = "Bugs"
- Green text/checkmarks = "Dev" 
- IDE interfaces (VSCode, etc) = "Dev"
- Terminal without red errors = "Dev"

INSTRUCTIONS:
1. Extract ALL visible text from the screenshot
2. Look specifically for error indicators first
3. If ANY error/failure content found → "Bugs" category
4. Otherwise classify normally
5. Set importance level (critical for docs/receipts, high for dev/bugs, low for social/temp)

Be extra careful to catch ALL error-related screenshots as "Bugs".`
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
      category: "uncategorized",
      description: "Analysis failed",
      extractedText: "Analysis failed - could not extract text",
      contentType: "other" as const,
      folderCategory: "Temp" as const,
      retentionPolicy: "delete_immediately" as const,
      importanceLevel: "low" as const
    };
  }
}

// Analyze screenshot without saving (lightweight)
app.post("/analyze", async (c) => {
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
    
    // Analyze screenshot without saving
    const analysis = await analyzeScreenshot(arrayBuffer, c.env);

    return c.json({
      filename: file.name,
      isImportant: analysis.isImportant,
      confidence: analysis.confidence,
      category: analysis.folderCategory,
      description: analysis.description,
      extractedText: analysis.extractedText,
      contentType: analysis.contentType,
      retentionPolicy: analysis.retentionPolicy,
      importanceLevel: analysis.importanceLevel
    }, 200);

  } catch (error) {
    console.error("Analysis failed:", error);
    return c.json({ error: "Analysis failed" }, 500);
  }
});

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

    // Handle single category
    const categoryName = analysis.folderCategory;
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

    return c.json({
      id: screenshot.id,
      filename: screenshot.filename,
      isImportant: analysis.isImportant,
      confidence: analysis.confidence,
      category: analysis.folderCategory,
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

  // Bill analysis tool
  server.tool(
    "analyze_bill",
    {
      imageData: z.string().describe("Base64 encoded bill image"),
      filename: z.string().describe("Original filename")
    },
    async ({ imageData, filename }) => {
      try {
        const buffer = Uint8Array.from(atob(imageData), c => c.charCodeAt(0)).buffer;
        const uint8Array = new Uint8Array(buffer);
        let binaryString = '';
        const chunkSize = 8192;
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.slice(i, i + chunkSize);
          binaryString += String.fromCharCode(...chunk);
        }
        const base64Image = btoa(binaryString);

        const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_AI_API_KEY });
        
        const billAnalysisSchema = z.object({
          totalAmount: z.string().describe("Total amount on the bill"),
          currency: z.string().describe("Currency symbol or code"),
          merchant: z.string().describe("Business or merchant name"),
          date: z.string().describe("Transaction date"),
          items: z.array(z.object({
            name: z.string(),
            price: z.string(),
            quantity: z.number().optional()
          })).describe("Individual line items"),
          taxes: z.string().optional().describe("Tax amount if visible"),
          tip: z.string().optional().describe("Tip amount if added"),
          paymentMethod: z.string().optional().describe("Payment method if visible"),
          confidence: z.number().min(0).max(1).describe("Confidence in OCR accuracy")
        });

        const result = await generateObject({
          model: google("gemini-2.5-flash"),
          messages: [
            {
              role: "user", 
              content: [
                {
                  type: "text",
                  text: "Analyze this bill/receipt image and extract all financial information with OCR precision. Focus on amounts, merchant details, and line items."
                },
                {
                  type: "image",
                  image: `data:image/jpeg;base64,${base64Image}`
                }
              ]
            }
          ],
          schema: billAnalysisSchema
        });

        const bill = result.object;
        const formattedItems = bill.items.map(item => 
          `• ${item.name}: ${item.price}${item.quantity ? ` (x${item.quantity})` : ''}`
        ).join('\n');

        return {
          content: [{
            type: "text",
            text: `Bill Analysis Complete:

🧾 BILL DETAILS:
• Merchant: ${bill.merchant}
• Date: ${bill.date}
• Total Amount: ${bill.currency}${bill.totalAmount}
${bill.taxes ? `• Taxes: ${bill.currency}${bill.taxes}` : ''}
${bill.tip ? `• Tip: ${bill.currency}${bill.tip}` : ''}
${bill.paymentMethod ? `• Payment: ${bill.paymentMethod}` : ''}

📋 LINE ITEMS:
${formattedItems}

📊 OCR CONFIDENCE: ${Math.round(bill.confidence * 100)}%

💡 TIP: Use this data for expense tracking and budget analysis.`
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Bill analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Translation tool
  server.tool(
    "translate_screenshot",
    {
      imageData: z.string().describe("Base64 encoded screenshot with text to translate"),
      filename: z.string().describe("Original filename"),
      targetLanguage: z.string().default("English").describe("Target language for translation")
    },
    async ({ imageData, filename, targetLanguage }) => {
      try {
        const buffer = Uint8Array.from(atob(imageData), c => c.charCodeAt(0)).buffer;
        const uint8Array = new Uint8Array(buffer);
        let binaryString = '';
        const chunkSize = 8192;
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.slice(i, i + chunkSize);
          binaryString += String.fromCharCode(...chunk);
        }
        const base64Image = btoa(binaryString);

        const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_AI_API_KEY });
        
        const translationSchema = z.object({
          detectedLanguage: z.string().describe("Original language detected"),
          extractedText: z.string().describe("Original text found in image"),
          translatedText: z.string().describe("Text translated to target language"),
          confidence: z.number().min(0).max(1).describe("Translation confidence"),
          textRegions: z.array(z.object({
            original: z.string(),
            translated: z.string(),
            position: z.string()
          })).describe("Individual text regions with translations")
        });

        const result = await generateObject({
          model: google("gemini-2.5-flash"),
          messages: [
            {
              role: "user", 
              content: [
                {
                  type: "text",
                  text: `Extract all text from this screenshot and translate it to ${targetLanguage}. Identify the original language and provide both original and translated versions.`
                },
                {
                  type: "image",
                  image: `data:image/jpeg;base64,${base64Image}`
                }
              ]
            }
          ],
          schema: translationSchema
        });

        const translation = result.object;
        const formattedRegions = translation.textRegions.map((region, i) => 
          `${i + 1}. "${region.original}" → "${region.translated}"`
        ).join('\n');

        return {
          content: [{
            type: "text",
            text: `Translation Complete:

🌍 LANGUAGE DETECTION:
• Original Language: ${translation.detectedLanguage}
• Target Language: ${targetLanguage}

📝 FULL TEXT TRANSLATION:
• Original: "${translation.extractedText}"
• Translated: "${translation.translatedText}"

🎯 TEXT REGIONS:
${formattedRegions}

📊 CONFIDENCE: ${Math.round(translation.confidence * 100)}%

💡 TIP: Use this for translating foreign language screenshots, documents, and signs.`
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Translation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Song lyrics extraction tool
  server.tool(
    "extract_song_lyrics",
    {
      imageData: z.string().describe("Base64 encoded screenshot of song lyrics"),
      filename: z.string().describe("Original filename")
    },
    async ({ imageData, filename }) => {
      try {
        const buffer = Uint8Array.from(atob(imageData), c => c.charCodeAt(0)).buffer;
        const uint8Array = new Uint8Array(buffer);
        let binaryString = '';
        const chunkSize = 8192;
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.slice(i, i + chunkSize);
          binaryString += String.fromCharCode(...chunk);
        }
        const base64Image = btoa(binaryString);

        const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_AI_API_KEY });
        
        const lyricsSchema = z.object({
          songTitle: z.string().describe("Song title if visible"),
          artist: z.string().describe("Artist name if visible"),
          album: z.string().optional().describe("Album name if visible"),
          lyrics: z.string().describe("Extracted lyrics text"),
          language: z.string().describe("Language of the lyrics"),
          genre: z.string().optional().describe("Music genre if identifiable"),
          confidence: z.number().min(0).max(1).describe("Extraction confidence"),
          lyricsComplete: z.boolean().describe("Whether the full song lyrics are visible"),
          isPartial: z.boolean().describe("Whether this is a partial excerpt")
        });

        const result = await generateObject({
          model: google("gemini-2.5-flash"),
          messages: [
            {
              role: "user", 
              content: [
                {
                  type: "text",
                  text: "Extract song lyrics from this screenshot. Identify song title, artist, and full lyrics text. Format the lyrics cleanly with proper line breaks."
                },
                {
                  type: "image",
                  image: `data:image/jpeg;base64,${base64Image}`
                }
              ]
            }
          ],
          schema: lyricsSchema
        });

        const song = result.object;
        const lyricsPreview = song.lyrics.length > 500 ? 
          song.lyrics.substring(0, 500) + "\n[Lyrics truncated for copyright compliance]" : 
          song.lyrics;

        return {
          content: [{
            type: "text",
            text: `Song Lyrics Extraction Complete:

🎵 SONG INFORMATION:
• Title: ${song.songTitle}
• Artist: ${song.artist}
${song.album ? `• Album: ${song.album}` : ''}
${song.genre ? `• Genre: ${song.genre}` : ''}
• Language: ${song.language}

📝 LYRICS ${song.isPartial ? '(PARTIAL)' : '(COMPLETE)'}:
${lyricsPreview}

📊 EXTRACTION CONFIDENCE: ${Math.round(song.confidence * 100)}%
🎼 COMPLETENESS: ${song.lyricsComplete ? 'Full song visible' : 'Partial lyrics only'}

💡 TIP: Use for music discovery and lyric analysis.`
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Lyrics extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Map analysis tool
  server.tool(
    "analyze_map_screenshot",
    {
      imageData: z.string().describe("Base64 encoded screenshot of a map"),
      filename: z.string().describe("Original filename")
    },
    async ({ imageData, filename }) => {
      try {
        const buffer = Uint8Array.from(atob(imageData), c => c.charCodeAt(0)).buffer;
        const uint8Array = new Uint8Array(buffer);
        let binaryString = '';
        const chunkSize = 8192;
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.slice(i, i + chunkSize);
          binaryString += String.fromCharCode(...chunk);
        }
        const base64Image = btoa(binaryString);

        const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_AI_API_KEY });
        
        const mapAnalysisSchema = z.object({
          locations: z.array(z.object({
            name: z.string(),
            type: z.enum(["city", "landmark", "street", "business", "poi", "other"]),
            coordinates: z.string().optional()
          })).describe("Identified locations in the map"),
          mapType: z.enum(["street", "satellite", "terrain", "hybrid", "transit", "other"]).describe("Type of map view"),
          zoomLevel: z.enum(["street", "neighborhood", "city", "region", "country", "world"]).describe("Approximate zoom level"),
          primaryLocation: z.string().describe("Main location or area shown"),
          directions: z.object({
            hasRoute: z.boolean(),
            startPoint: z.string().optional(),
            endPoint: z.string().optional(),
            estimatedDistance: z.string().optional()
          }).describe("Route information if visible"),
          confidence: z.number().min(0).max(1).describe("Analysis confidence")
        });

        const result = await generateObject({
          model: google("gemini-2.5-flash"),
          messages: [
            {
              role: "user", 
              content: [
                {
                  type: "text",
                  text: "Analyze this map screenshot and identify locations, landmarks, route information, and map characteristics. Extract any visible place names, addresses, or navigation details."
                },
                {
                  type: "image",
                  image: `data:image/jpeg;base64,${base64Image}`
                }
              ]
            }
          ],
          schema: mapAnalysisSchema
        });

        const map = result.object;
        const locationsList = map.locations.map(loc => 
          `• ${loc.name} (${loc.type})`
        ).join('\n');

        // Try to get coordinates for primary location using free geocoding
        let coordinateInfo = '';
        try {
          const geocodeUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(map.primaryLocation)}&limit=1`;
          const geoResponse = await fetch(geocodeUrl, {
            headers: {
              'User-Agent': 'ScreenSift-MCP/1.0'
            }
          });
          
          if (geoResponse.ok) {
            const geoData = await geoResponse.json();
            if (geoData.length > 0) {
              const place = geoData[0];
              coordinateInfo = `\n📍 COORDINATES: ${place.lat}, ${place.lon}`;
            }
          }
        } catch (geoError) {
          // Silently fail geocoding
        }

        return {
          content: [{
            type: "text",
            text: `Map Analysis Complete:

🗺️ MAP DETAILS:
• Primary Location: ${map.primaryLocation}${coordinateInfo}
• Map Type: ${map.mapType}
• Zoom Level: ${map.zoomLevel}

📍 IDENTIFIED LOCATIONS:
${locationsList}

🛣️ NAVIGATION INFO:
• Has Route: ${map.directions.hasRoute ? 'Yes' : 'No'}
${map.directions.startPoint ? `• Start: ${map.directions.startPoint}` : ''}
${map.directions.endPoint ? `• End: ${map.directions.endPoint}` : ''}
${map.directions.estimatedDistance ? `• Distance: ${map.directions.estimatedDistance}` : ''}

📊 ANALYSIS CONFIDENCE: ${Math.round(map.confidence * 100)}%

💡 TIP: Use for travel planning, location identification, and navigation analysis.`
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Map analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Enhanced QR code reader with dedicated libraries
  server.tool(
    "read_qr_code",
    {
      imageData: z.string().describe("Base64 encoded screenshot containing QR code or barcode"),
      filename: z.string().describe("Original filename")
    },
    async ({ imageData, filename }) => {
      try {
        const buffer = Uint8Array.from(atob(imageData), c => c.charCodeAt(0)).buffer;
        
        let qrResults: any[] = [];
        let libraryScanSuccess = false;
        
        try {
          // Load image with Jimp
          const image = await Jimp.read(Buffer.from(buffer));
          const qr = new QrCode();
          
          // Scan for QR codes using the dedicated library
          const qrPromise = new Promise((resolve, reject) => {
            qr.callback = (err: any, value: any) => {
              if (err) {
                reject(err);
              } else {
                resolve(value);
              }
            };
          });
          
          qr.decode(image.bitmap);
          const qrResult = await qrPromise;
          
          if (qrResult && (qrResult as any).result) {
            libraryScanSuccess = true;
            qrResults.push({
              type: "qr_code",
              content: (qrResult as any).result,
              position: "detected",
              confidence: 1.0,
              scanMethod: "QR Library"
            });
          }
        } catch (libraryError) {
          console.log("QR library scan failed, falling back to AI:", libraryError);
        }
        
        // If library scan failed, fall back to AI analysis
        if (!libraryScanSuccess) {
          const uint8Array = new Uint8Array(buffer);
          let binaryString = '';
          const chunkSize = 8192;
          for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.slice(i, i + chunkSize);
            binaryString += String.fromCharCode(...chunk);
          }
          const base64Image = btoa(binaryString);

          const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_AI_API_KEY });
          
          const qrAnalysisSchema = z.object({
            codes: z.array(z.object({
              type: z.enum(["qr_code", "barcode", "data_matrix", "other"]),
              content: z.string(),
              dataType: z.enum(["url", "text", "wifi", "contact", "email", "phone", "sms", "location", "calendar", "product", "other"]),
              position: z.string()
            })),
            confidence: z.number().min(0).max(1)
          });

          const result = await generateObject({
            model: google("gemini-2.5-flash"),
            messages: [
              {
                role: "user", 
                content: [
                  {
                    type: "text",
                    text: "Analyze this image and detect/decode any QR codes or barcodes. Focus on extracting the exact content."
                  },
                  {
                    type: "image",
                    image: `data:image/jpeg;base64,${base64Image}`
                  }
                ]
              }
            ],
            schema: qrAnalysisSchema
          });

          // Convert AI results to our format
          qrResults = result.object.codes.map(code => ({
            type: code.type,
            content: code.content,
            position: code.position,
            confidence: result.object.confidence,
            scanMethod: "AI Vision"
          }));
        }
        
        // Process and format the results
        let formattedResults = '';
        
        if (qrResults.length === 0) {
          formattedResults = '❌ No QR codes or barcodes detected in this image.';
        } else {
          formattedResults = qrResults.map((code, index) => {
            let formatted = `\n📱 CODE ${index + 1} (${code.type?.toUpperCase() || 'QR_CODE'}):`;
            formatted += `\n• Content: ${code.content}`;
            formatted += `\n• Scan Method: ${code.scanMethod || 'Unknown'}`;
            formatted += `\n• Confidence: ${Math.round((code.confidence || 0) * 100)}%`;
            
            // Determine data type from content
            let dataType = 'text';
            if (code.content.startsWith('http://') || code.content.startsWith('https://')) {
              dataType = 'url';
              try {
                const url = new URL(code.content);
                formatted += `\n• 🔗 Clickable Link: ${code.content}`;
                formatted += `\n• Domain: ${url.hostname}`;
              } catch (e) {
                formatted += `\n• 🔗 URL: ${code.content}`;
              }
            } else if (code.content.startsWith('WIFI:')) {
              dataType = 'wifi';
              const wifiMatch = code.content.match(/WIFI:T:([^;]*);S:([^;]*);P:([^;]*);/);
              if (wifiMatch) {
                formatted += `\n• 📶 Network: ${wifiMatch[2]}`;
                formatted += `\n• 🔒 Security: ${wifiMatch[1]}`;
                formatted += `\n• 🔑 Password: ${wifiMatch[3]}`;
              }
            } else if (code.content.includes('BEGIN:VCARD')) {
              dataType = 'contact';
              const nameMatch = code.content.match(/FN:([^\n\r]*)/);
              const phoneMatch = code.content.match(/TEL:([^\n\r]*)/);
              const emailMatch = code.content.match(/EMAIL:([^\n\r]*)/);
              
              if (nameMatch) formatted += `\n• 👤 Name: ${nameMatch[1]}`;
              if (phoneMatch) formatted += `\n• 📞 Phone: ${phoneMatch[1]}`;
              if (emailMatch) formatted += `\n• 📧 Email: ${emailMatch[1]}`;
            }
            
            formatted += `\n• Data Type: ${dataType}`;
            return formatted;
          }).join('\n\n');
        }

        // Generate summary statistics
        const totalCodes = qrResults.length;
        const qrCodes = qrResults.filter(r => r.type === 'qr_code' || !r.type).length;
        const barcodes = qrResults.filter(r => r.type === 'barcode').length;
        const avgConfidence = qrResults.length > 0 ? Math.round(qrResults.reduce((sum, r) => sum + (r.confidence || 0), 0) / qrResults.length * 100) : 0;

        return {
          content: [{
            type: "text",
            text: `QR Code Analysis Complete:

📊 DETECTION SUMMARY:
• QR Codes Found: ${qrCodes}
• Barcodes Found: ${barcodes}
• Total Codes: ${totalCodes}
• Average Confidence: ${avgConfidence}%
• Scan Method: ${qrResults[0]?.scanMethod || 'None'}

${formattedResults}

💡 TIPS:
${qrResults.some(c => c.content.startsWith('http')) ? '• Click links to open in browser' : ''}
${qrResults.some(c => c.content.startsWith('WIFI:')) ? '• Use WiFi details to connect to network' : ''}
${qrResults.some(c => c.content.includes('BEGIN:VCARD')) ? '• Save contact information to your phone' : ''}
${qrResults.length === 0 ? '• Try a clearer image or check if codes are fully visible' : ''}

🔧 ENHANCED SCANNING:
• Uses dedicated QR library for maximum accuracy
• Falls back to AI vision if library scan fails
• Supports all QR code formats and data types`
          }]
        };

      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `QR code analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
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