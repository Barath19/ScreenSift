# ScreenSift MCP Specification

This document outlines the design and implementation plan for ScreenSift MCP, an automated screenshot classification and organization system using AI vision analysis.

The MCP server will analyze screenshots uploaded via Apple Shortcuts, intelligently categorize them using Google's Gemini Vision API, and provide organized access to important screenshots while filtering out digital clutter. Screenshots will be stored in Cloudflare R2 with metadata tracked in a SQLite database.

The system will be built using Cloudflare Workers with Hono as the API framework, Drizzle ORM for database operations, Cloudflare D1 for data storage, and Cloudflare R2 for screenshot blob storage.

## 1. Technology Stack

- **Edge Runtime:** Cloudflare Workers
- **API Framework:** Hono.js (TypeScript-based API framework)
- **Database:** Cloudflare D1 (serverless SQLite)
- **ORM:** Drizzle ORM for type-safe database operations
- **Blob Storage:** Cloudflare R2 for screenshot storage
- **AI Vision:** Google Gemini 2.5 Flash for image analysis
- **MCP Framework:** @modelcontextprotocol/sdk and @hono/mcp

## 2. Database Schema Design

The database will track screenshot metadata, AI analysis results, and organization categories.

### 2.1. Screenshots Table

- id (TEXT, Primary Key, UUID)
- filename (TEXT, Not Null) - Original filename from upload
- r2_key (TEXT, Not Null, Unique) - R2 storage key/path
- file_size (INTEGER, Not Null) - File size in bytes
- mime_type (TEXT, Not Null) - Image MIME type
- uploaded_at (INTEGER, Not Null) - Unix timestamp
- analyzed_at (INTEGER) - When AI analysis completed
- is_important (BOOLEAN, Default false) - AI classification result
- confidence_score (REAL) - AI confidence in classification (0-1)

### 2.2. Categories Table

- id (INTEGER, Primary Key, Auto Increment)
- name (TEXT, Not Null, Unique) - Category name (e.g., "receipts", "memes", "work")
- description (TEXT) - Category description
- created_at (INTEGER, Not Null) - Unix timestamp

### 2.3. Screenshot_Categories Table

- screenshot_id (TEXT, Foreign Key to Screenshots.id)
- category_id (INTEGER, Foreign Key to Categories.id)
- confidence (REAL) - Confidence in this categorization (0-1)
- Primary Key (screenshot_id, category_id)

### 2.4. Analysis_Results Table

- id (INTEGER, Primary Key, Auto Increment)
- screenshot_id (TEXT, Foreign Key to Screenshots.id)
- analysis_type (TEXT, Not Null) - Type of analysis performed
- result_data (TEXT, Not Null) - JSON blob of analysis results
- created_at (INTEGER, Not Null) - Unix timestamp

## 3. API Endpoints

The API will provide screenshot upload, analysis, and retrieval capabilities for both Apple Shortcuts integration and MCP client access.

### 3.1. Screenshot Upload Endpoints

- **POST /upload**
  - Description: Upload screenshot for analysis and storage
  - Expected Payload: Multipart form data with image file
  - Response: Screenshot metadata and analysis job ID

- **GET /screenshots/{id}**
  - Description: Retrieve screenshot file from R2 storage
  - Response: Image file with appropriate headers

### 3.2. Analysis Endpoints

- **GET /screenshots/{id}/analysis**
  - Description: Get AI analysis results for a screenshot
  - Response: Analysis metadata, categories, and importance classification

- **POST /screenshots/{id}/reanalyze**
  - Description: Trigger re-analysis of existing screenshot
  - Response: New analysis job status

### 3.3. Organization Endpoints

- **GET /screenshots**
  - Description: List screenshots with filtering options
  - Query Params: category, important_only, limit, offset, date_range
  - Response: Paginated list of screenshot metadata

- **GET /categories**
  - Description: List all available categories
  - Response: Array of category objects with usage statistics

- **DELETE /screenshots/{id}**
  - Description: Delete screenshot and associated metadata
  - Response: Deletion confirmation

### 3.4. MCP Server Endpoint

- **ALL /mcp**
  - Description: MCP JSON-RPC endpoint for client communication
  - Handles: Tool calls for screenshot analysis, organization, and retrieval

## 4. MCP Tools and Resources

The MCP server will expose the following tools and resources:

### 4.1. Tools

- **analyze_screenshot**: Upload and analyze a new screenshot
- **search_screenshots**: Search screenshots by category, date, or importance
- **organize_screenshots**: Bulk organize screenshots into categories
- **cleanup_clutter**: Identify and optionally delete low-importance screenshots
- **get_screenshot_stats**: Get statistics about screenshot collection

### 4.2. Resources

- **screenshot://{id}**: Access individual screenshot metadata and analysis
- **category://{name}**: Access screenshots in a specific category
- **important://**: Access only important/high-value screenshots

## 5. AI Analysis Pipeline

The system will use Google Gemini 2.5 Flash for intelligent screenshot classification:

### 5.1. Analysis Categories

- **Important Content**: Receipts, documents, work-related screenshots, educational content
- **Digital Clutter**: Memes, social media screenshots, temporary content, duplicates
- **Personal**: Photos, personal conversations, creative content
- **Technical**: Code snippets, error messages, technical documentation

### 5.2. Classification Logic

- Analyze visual content and text within screenshots
- Assign importance scores based on content type and context
- Categorize into predefined and dynamically created categories
- Identify potential duplicates or near-duplicates
- Extract relevant metadata (text content, timestamps, source applications)

## 6. Integrations

- **Google Gemini API**: For AI-powered image analysis and classification
- **Cloudflare R2**: For scalable screenshot storage with environment binding `c.env.R2`
- **Apple Shortcuts**: Integration endpoint for seamless screenshot capture workflow

## 7. Additional Notes

### 7.1. Storage Strategy

Screenshots will be stored in R2 with organized key structure: `screenshots/{year}/{month}/{uuid}.{ext}`

### 7.2. Performance Considerations

- Implement lazy loading for screenshot analysis
- Use background processing for batch operations
- Cache frequently accessed analysis results
- Optimize R2 access patterns for common queries

### 7.3. Privacy and Security

- Screenshots contain potentially sensitive information
- Implement secure deletion for unwanted screenshots
- Consider data retention policies for analysis results

## 8. Further Reading

Take inspiration from the project template here: https://github.com/fiberplane/create-honc-app/tree/main/templates/d1