# ScreenSift MCP 🔍

![ScreenSift Banner](banner.png)

> AI-powered screenshot classification and organization system with automatic folder management

## 🌟 Features

### 🤖 Smart AI Classification
- **Secrets Detection** - Automatically flags API keys, passwords, and sensitive data
- **Error Recognition** - Identifies bugs, stack traces, and red terminal text  
- **Development Work** - Recognizes IDEs, successful builds, and green terminal output
- **Document Processing** - Classifies important docs, receipts, and papers
- **Social Content** - Detects memes, social media, and temporary content
- **OCR Text Extraction** - Extracts all visible text from screenshots

### 📁 Automatic Organization
Screenshots are automatically sorted into 6 smart folders:
- **`Secrets/`** - API keys, passwords, tokens (⚠️ High Priority)
- **`Bugs/`** - Error messages, stack traces, red terminal text
- **`Dev/`** - IDEs, working code, successful builds, green terminal
- **`Documents/`** - Important docs, receipts, papers
- **`Social/`** - Memes, social media content  
- **`Temp/`** - Temporary/junk content

### ⏰ Intelligent Retention Policies
- **Keep Permanently**: Secrets, Bugs, Dev, Documents
- **Delete after 7 days**: Social content
- **Delete Immediately**: Temp/junk content

### 🍎 Apple Shortcuts Integration
Take screenshots and automatically:
1. Upload to AI for analysis
2. Classify content type
3. Save to appropriate folder
4. Show classification results

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Google AI API key (Gemini)
- Cloudflare account (for deployment)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd vibesummer-week1
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment**
   ```bash
   echo "GOOGLE_AI_API_KEY=your-api-key-here" > .env
   ```

4. **Set up database**
   ```bash
   npm run db:setup
   ```

5. **Start development server**
   ```bash
   npm run dev
   ```

Server runs at `http://localhost:8787` 🎉

**🌐 Live Demo:** `https://screensift-mcp.bharathkumaradinarayan.workers.dev`

## 📸 Apple Shortcut

![Apple Shortcut](apple-shortcut.png)

*Example screenshot that gets automatically classified by the AI system*

## 🔧 Configuration

### Environment Variables
```bash
GOOGLE_AI_API_KEY=your-gemini-api-key
```

### Wrangler Configuration
Update `wrangler.jsonc` with your settings:
```json
{
  "vars": {
    "GOOGLE_AI_API_KEY": "your-key-here"
  }
}
```

## 📱 Apple Shortcuts Setup

### Option 1: Import Ready-Made Shortcut
1. **Download** the `ScreenSift.shortcut` file from this repository
2. **Double-click** the file to import into Shortcuts app
3. **Configure server URL** if needed (cloud or local analyze endpoint)
4. **Assign keyboard shortcut**: **Shift+Cmd+2** recommended

### Option 2: Create Manually

1. **Take Screenshot** - Capture screen/selection
2. **Get Contents of URL** 
   - URL: `https://screensift-mcp.bharathkumaradinarayan.workers.dev/analyze` (cloud) or `http://localhost:8787/analyze` (local)
   - Method: `POST`
   - Form data: `file` = Screenshot
3. **Get Value from Dictionary**
   - Dictionary: Contents of URL
   - Key: `category`
4. **Save File**
   - File: Screenshot
   - Destination: `~/Desktop/Screenshots/[category]/`

### Usage
- Run shortcut → AI analyzes → Saves to correct folder
- View classification results in notification
- Screenshots automatically organized into smart folders:
  - `~/Desktop/Screenshots/Secrets/`
  - `~/Desktop/Screenshots/Bugs/`
  - `~/Desktop/Screenshots/Dev/`
  - `~/Desktop/Screenshots/Documents/`
  - `~/Desktop/Screenshots/Social/`
  - `~/Desktop/Screenshots/Temp/`

## 🛠 API Endpoints

### Analyze Only (No Storage)
```bash
# Cloud
POST https://screensift-mcp.bharathkumaradinarayan.workers.dev/analyze

# Local  
POST http://localhost:8787/analyze

Content-Type: multipart/form-data
file: [image file]
```

**Response:**
```json
{
  "filename": "screenshot.png",
  "isImportant": true,
  "confidence": 0.95,
  "category": "Dev",
  "description": "VSCode with TypeScript code...",
  "extractedText": "console.log('hello world')",
  "contentType": "dev",
  "retentionPolicy": "keep",
  "importanceLevel": "high"
}
```



### MCP Protocol
```bash
POST /mcp
Content-Type: application/json
```

**Available Tools:**
- `analyze_screenshot` - Upload and analyze images
- `search_screenshots` - Find by category/importance  
- `cleanup_clutter` - Remove unimportant screenshots
- `get_screenshot_stats` - View storage statistics

## 🗄 API Response Schema

### Analyze Response
```json
{
  "filename": "screenshot.png",
  "isImportant": true,
  "confidence": 0.95,
  "category": "Dev",
  "description": "AI description of content",
  "extractedText": "OCR text from image",
  "contentType": "dev",
  "retentionPolicy": "keep",
  "importanceLevel": "high"
}
```

### Categories
- **Secrets** - API keys, passwords, sensitive data
- **Bugs** - Error messages, stack traces, red text
- **Dev** - IDEs, working code, green terminal
- **Documents** - Important docs, receipts
- **Social** - Memes, social media content
- **Temp** - Temporary/junk content

## 🧪 Testing

### Web Interface
Open `test-ui.html` in browser for drag-and-drop testing.

### Command Line
```bash
# Test server (local)
curl http://localhost:8787

# Test server (cloud)
curl https://screensift-mcp.bharathkumaradinarayan.workers.dev

# Analyze screenshot (local)
curl -X POST -F "file=@screenshot.png" http://localhost:8787/analyze

# Analyze screenshot (cloud)
curl -X POST -F "file=@screenshot.png" https://screensift-mcp.bharathkumaradinarayan.workers.dev/analyze

```

## 🚀 Deployment

### Cloudflare Workers
```bash
npm run deploy
```

### Environment Setup
1. Set up D1 database
2. Configure environment variables
3. Run migrations: `npm run db:migrate:prod`

## 🔍 How It Works

### AI Classification Pipeline
1. **Image Upload** → Analysis Only
2. **Gemini Vision Analysis** → OCR + Classification  
3. **Smart Categorization** → 6 folder system
4. **Response** → Category + metadata
5. **File Organization** → Local folder structure via Apple Shortcuts

### Classification Logic
```
Secrets Detection (Priority 1)
├── API keys, passwords, tokens
├── Environment files, credentials
└── Sensitive configuration

Error Detection (Priority 2)  
├── Red terminal text, stack traces
├── Error dialogs, exceptions
└── Failed build outputs

Development Work (Priority 3)
├── IDEs (VSCode, etc.)
├── Successful builds, green terminal
└── Code documentation

Documents → Important papers, receipts
Social → Memes, social media content  
Temp → Junk, temporary content
```

## 📊 Analytics

### Storage Statistics
- Total screenshots processed
- Category distribution
- Storage usage by folder
- Retention policy effectiveness

### Cleanup Automation
- Social content expires after 7 days
- Temp content deleted immediately  
- Important content preserved permanently

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open Pull Request

## 📄 License

This project is licensed under the MIT License - see LICENSE file for details.

## 🙏 Acknowledgments

- **Google Gemini** - AI vision and text analysis
- **Cloudflare Workers** - Serverless hosting platform
- **Drizzle ORM** - Database management
- **Hono** - Web framework
- **Apple Shortcuts** - Automation integration

---

**Built with ❤️ for automatic screenshot organization**

*Stop manually organizing screenshots - let AI do it for you!* 🤖✨