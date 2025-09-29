#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  CallToolRequest,
  CallToolResult,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { config as dotenvConfig } from "dotenv";
import os from "os";

// Load environment variables
dotenvConfig();

const ConfigSchema = z.object({
  geminiApiKey: z.string().min(1, "Gemini API key is required"),
});

type Config = z.infer<typeof ConfigSchema>;

class NanoBananaMCP {
  private server: Server;
  private genAI: GoogleGenAI | null = null;
  private config: Config | null = null;
  private lastImagePath: string | null = null;
  private configSource: 'environment' | 'config_file' | 'not_configured' = 'not_configured';

  constructor() {
    this.server = new Server(
      {
        name: "nano-banana-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "configure_gemini_token",
            description: "Configure your Gemini API token for nano-banana image generation",
            inputSchema: {
              type: "object",
              properties: {
                apiKey: {
                  type: "string",
                  description: "Your Gemini API key from Google AI Studio",
                },
              },
              required: ["apiKey"],
            },
          },
          {
            name: "generate_image",
            description: "Generate a NEW image from text prompt. Use this ONLY when creating a completely new image, not when modifying an existing one.",
            inputSchema: {
              type: "object",
              properties: {
                prompt: {
                  type: "string",
                  description: "Text prompt describing the NEW image to create from scratch",
                },
              },
              required: ["prompt"],
            },
          },
          {
            name: "edit_image",
            description: "Edit a SPECIFIC existing image file, optionally using additional reference images. Use this when you have the exact file path of an image to modify.",
            inputSchema: {
              type: "object",
              properties: {
                imagePath: {
                  type: "string",
                  description: "Full file path to the main image file to edit",
                },
                prompt: {
                  type: "string",
                  description: "Text describing the modifications to make to the existing image",
                },
                referenceImages: {
                  type: "array",
                  items: {
                    type: "string"
                  },
                  description: "Optional array of file paths to additional reference images to use during editing (e.g., for style transfer, adding elements, etc.)",
                },
              },
              required: ["imagePath", "prompt"],
            },
          },
          {
            name: "get_configuration_status",
            description: "Check if Gemini API token is configured",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "continue_editing",
            description: "Continue editing the LAST image that was generated or edited in this session, optionally using additional reference images. Use this for iterative improvements, modifications, or changes to the most recent image. This automatically uses the previous image without needing a file path.",
            inputSchema: {
              type: "object",
              properties: {
                prompt: {
                  type: "string",
                  description: "Text describing the modifications/changes/improvements to make to the last image (e.g., 'change the hat color to red', 'remove the background', 'add flowers')",
                },
                referenceImages: {
                  type: "array",
                  items: {
                    type: "string"
                  },
                  description: "Optional array of file paths to additional reference images to use during editing (e.g., for style transfer, adding elements from other images, etc.)",
                },
              },
              required: ["prompt"],
            },
          },
          {
            name: "get_last_image_info",
            description: "Get information about the last generated/edited image in this session (file path, size, etc.). Use this to check what image is currently available for continue_editing.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ] as Tool[],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
      try {
        switch (request.params.name) {
          case "configure_gemini_token":
            return await this.configureGeminiToken(request);
          
          case "generate_image":
            return await this.generateImage(request);
          
          case "edit_image":
            return await this.editImage(request);
          
          case "get_configuration_status":
            return await this.getConfigurationStatus();
          
          case "continue_editing":
            return await this.continueEditing(request);
          
          case "get_last_image_info":
            return await this.getLastImageInfo();
          
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private async configureGeminiToken(request: CallToolRequest): Promise<CallToolResult> {
    const { apiKey } = request.params.arguments as { apiKey: string };
    
    try {
      ConfigSchema.parse({ geminiApiKey: apiKey });
      
      this.config = { geminiApiKey: apiKey };
      this.genAI = new GoogleGenAI({ apiKey });
      this.configSource = 'config_file'; // Manual configuration via tool
      
      await this.saveConfig();
      
      return {
        content: [
          {
            type: "text",
            text: "✅ Gemini API token configured successfully! You can now use nano-banana image generation features.",
          },
        ],
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid API key: ${error.errors[0]?.message}`);
      }
      throw error;
    }
  }

  private async generateImage(request: CallToolRequest): Promise<CallToolResult> {
    if (!this.ensureConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "Gemini API token not configured. Use configure_gemini_token first.");
    }

    const { prompt } = request.params.arguments as { prompt: string };
    
    try {
      const response = await this.genAI!.models.generateContent({
        model: "gemini-2.5-flash-image-preview",
        contents: prompt,
      });
      
      // Process response to extract image data
      const savedFiles: string[] = [];
      let textContent = "";
      
      // Get appropriate save directory based on OS
      let imagesDir = this.getImagesDirectory();

      // Create directory with fallback
      try {
        await fs.mkdir(imagesDir, { recursive: true, mode: 0o755 });
      } catch (error) {
        // Fallback to home directory if mkdir fails
        const homeDir = os.homedir();
        imagesDir = path.join(homeDir, 'nano-banana-images');
        await fs.mkdir(imagesDir, { recursive: true, mode: 0o755 });
      }
      
      if (response.candidates && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          // Process text content
          if (part.text) {
            textContent += part.text;
          }
          
          // Process image data
          if (part.inlineData?.data) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const randomId = Math.random().toString(36).substring(2, 8);
            const fileName = `generated-${timestamp}-${randomId}.png`;
            const filePath = path.join(imagesDir, fileName);
            
            const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
            await fs.writeFile(filePath, imageBuffer);
            savedFiles.push(filePath);
            this.lastImagePath = filePath;

            // Note: Skip adding image data to avoid MCP response size limits
            // Image is saved to disk and path is included in status text
          }
        }
      }
      
      // Build response content
      let statusText = `🎨 Image generated with nano-banana (Gemini 2.5 Flash Image)!\n\nPrompt: "${prompt}"`;
      
      if (textContent) {
        statusText += `\n\nDescription: ${textContent}`;
      }
      
      if (savedFiles.length > 0) {
        statusText += `\n\n📁 Image saved to:\n${savedFiles.map(f => `- ${f}`).join('\n')}`;
        statusText += `\n\n🖼️ **Note:** Due to response size limits, images are not displayed inline but are fully saved to disk.`;
        statusText += `\n\n💡 View the image by opening the file at the path above.`;
        statusText += `\n\n🔄 To modify this image, use: continue_editing`;
        statusText += `\n📋 To check current image info, use: get_last_image_info`;
      } else {
        statusText += `\n\nNote: No image was generated. The model may have returned only text.`;
        statusText += `\n\n💡 Tip: Try running the command again - sometimes the first call needs to warm up the model.`;
      }
      
      // Return only text content to avoid MCP response size limits
      return {
        content: [{
          type: "text",
          text: statusText,
        }]
      };
      
    } catch (error) {
      console.error("Error generating image:", error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to generate image: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async editImage(request: CallToolRequest): Promise<CallToolResult> {
    if (!this.ensureConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "Gemini API token not configured. Use configure_gemini_token first.");
    }

    const { imagePath, prompt, referenceImages } = request.params.arguments as { 
      imagePath: string; 
      prompt: string; 
      referenceImages?: string[];
    };
    
    try {
      // Prepare the main image
      const imageBuffer = await fs.readFile(imagePath);
      const mimeType = this.getMimeType(imagePath);
      const imageBase64 = imageBuffer.toString('base64');
      
      // Prepare all image parts
      const imageParts: any[] = [
        { 
          inlineData: {
            data: imageBase64,
            mimeType: mimeType,
          }
        }
      ];
      
      // Add reference images if provided
      if (referenceImages && referenceImages.length > 0) {
        for (const refPath of referenceImages) {
          try {
            const refBuffer = await fs.readFile(refPath);
            const refMimeType = this.getMimeType(refPath);
            const refBase64 = refBuffer.toString('base64');
            
            imageParts.push({
              inlineData: {
                data: refBase64,
                mimeType: refMimeType,
              }
            });
          } catch (error) {
            // Continue with other images, don't fail the entire operation
            continue;
          }
        }
      }
      
      // Add the text prompt
      imageParts.push({ text: prompt });
      
      // Use new API format with multiple images and text
      const response = await this.genAI!.models.generateContent({
        model: "gemini-2.5-flash-image-preview",
        contents: [
          {
            parts: imageParts
          }
        ],
      });
      
      // Process response
      const savedFiles: string[] = [];
      let textContent = "";
      
      // Get appropriate save directory
      let imagesDir = this.getImagesDirectory();

      // Create directory with fallback
      try {
        await fs.mkdir(imagesDir, { recursive: true, mode: 0o755 });
      } catch (error) {
        // Fallback to home directory if mkdir fails
        const homeDir = os.homedir();
        imagesDir = path.join(homeDir, 'nano-banana-images');
        await fs.mkdir(imagesDir, { recursive: true, mode: 0o755 });
      }
      
      // Extract image from response
      if (response.candidates && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.text) {
            textContent += part.text;
          }
          
          if (part.inlineData) {
            // Save edited image
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const randomId = Math.random().toString(36).substring(2, 8);
            const fileName = `edited-${timestamp}-${randomId}.png`;
            const filePath = path.join(imagesDir, fileName);
            
            if (part.inlineData.data) {
              const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
              await fs.writeFile(filePath, imageBuffer);
              savedFiles.push(filePath);
              this.lastImagePath = filePath;
            }

            // Note: Skip adding image data to avoid MCP response size limits
            // Image is saved to disk and path is included in status text
          }
        }
      }
      
      // Build response
      let statusText = `🎨 Image edited with nano-banana!\n\nOriginal: ${imagePath}\nEdit prompt: "${prompt}"`;
      
      if (referenceImages && referenceImages.length > 0) {
        statusText += `\n\nReference images used:\n${referenceImages.map(f => `- ${f}`).join('\n')}`;
      }
      
      if (textContent) {
        statusText += `\n\nDescription: ${textContent}`;
      }
      
      if (savedFiles.length > 0) {
        statusText += `\n\n📁 Edited image saved to:\n${savedFiles.map(f => `- ${f}`).join('\n')}`;
        statusText += `\n\n🖼️ **Note:** Due to response size limits, images are not displayed inline but are fully saved to disk.`;
        statusText += `\n\n💡 View the edited image by opening the file at the path above.`;
        statusText += `\n\n🔄 To continue editing, use: continue_editing`;
        statusText += `\n📋 To check current image info, use: get_last_image_info`;
      } else {
        statusText += `\n\nNote: No edited image was generated.`;
        statusText += `\n\n💡 Tip: Try running the command again - sometimes the first call needs to warm up the model.`;
      }
      
      // Return only text content to avoid MCP response size limits
      return {
        content: [{
          type: "text",
          text: statusText,
        }]
      };
      
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to edit image: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getConfigurationStatus(): Promise<CallToolResult> {
    const isConfigured = this.config !== null && this.genAI !== null;
    
    let statusText: string;
    let sourceInfo = "";
    
    if (isConfigured) {
      statusText = "✅ Gemini API token is configured and ready to use";
      
      switch (this.configSource) {
        case 'environment':
          sourceInfo = "\n📍 Source: Environment variable (GEMINI_API_KEY)\n💡 This is the most secure configuration method.";
          break;
        case 'config_file':
          sourceInfo = "\n📍 Source: Local configuration file (.nano-banana-config.json)\n💡 Consider using environment variables for better security.";
          break;
      }
    } else {
      statusText = "❌ Gemini API token is not configured";
      sourceInfo = `

📝 Configuration options (in priority order):
1. 🥇 MCP client environment variables (Recommended)
2. 🥈 System environment variable: GEMINI_API_KEY  
3. 🥉 Use configure_gemini_token tool

💡 For the most secure setup, add this to your MCP configuration:
"env": { "GEMINI_API_KEY": "your-api-key-here" }`;
    }
    
    return {
      content: [
        {
          type: "text",
          text: statusText + sourceInfo,
        },
      ],
    };
  }

  private async continueEditing(request: CallToolRequest): Promise<CallToolResult> {
    if (!this.ensureConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "Gemini API token not configured. Use configure_gemini_token first.");
    }

    if (!this.lastImagePath) {
      throw new McpError(ErrorCode.InvalidRequest, "No previous image found. Please generate or edit an image first, then use continue_editing for subsequent edits.");
    }

    const { prompt, referenceImages } = request.params.arguments as { 
      prompt: string; 
      referenceImages?: string[];
    };

    // 检查最后的图片文件是否存在
    try {
      await fs.access(this.lastImagePath);
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, `Last image file not found at: ${this.lastImagePath}. Please generate a new image first.`);
    }

    // Use editImage logic with lastImagePath
    
    return await this.editImage({
      method: "tools/call",
      params: {
        name: "edit_image",
        arguments: {
          imagePath: this.lastImagePath,
          prompt: prompt,
          referenceImages: referenceImages
        }
      }
    } as CallToolRequest);
  }

  private async getLastImageInfo(): Promise<CallToolResult> {
    if (!this.lastImagePath) {
      return {
        content: [
          {
            type: "text",
            text: "📷 No previous image found.\n\nPlease generate or edit an image first, then this command will show information about your last image.",
          },
        ],
      };
    }

    // 检查文件是否存在
    try {
      await fs.access(this.lastImagePath);
      const stats = await fs.stat(this.lastImagePath);
      
      return {
        content: [
          {
            type: "text",
            text: `📷 Last Image Information:\n\nPath: ${this.lastImagePath}\nFile Size: ${Math.round(stats.size / 1024)} KB\nLast Modified: ${stats.mtime.toLocaleString()}\n\n💡 Use continue_editing to make further changes to this image.`,
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `📷 Last Image Information:\n\nPath: ${this.lastImagePath}\nStatus: ❌ File not found\n\n💡 The image file may have been moved or deleted. Please generate a new image.`,
          },
        ],
      };
    }
  }

  private ensureConfigured(): boolean {
    return this.config !== null && this.genAI !== null;
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.png':
        return 'image/png';
      case '.webp':
        return 'image/webp';
      default:
        return 'image/jpeg';
    }
  }

  private getImagesDirectory(): string {
    const platform = os.platform();
    const homeDir = os.homedir();

    if (platform === 'win32') {
      // Windows: Use Documents folder
      return path.join(homeDir, 'Documents', 'nano-banana-images');
    } else {
      // macOS/Linux: Use home directory for better compatibility
      const cwd = process.cwd();

      // If in system directories or root directories, use home directory instead
      if (cwd.startsWith('/usr/') || cwd.startsWith('/opt/') || cwd.startsWith('/var/') ||
          cwd.startsWith('/bin/') || cwd.startsWith('/sbin/') || cwd === '/') {
        return path.join(homeDir, 'nano-banana-images');
      }

      // For other directories, try to use current directory, but fallback to home if it fails
      try {
        const targetDir = path.resolve(cwd, 'generated_imgs');
        return targetDir;
      } catch (error) {
        return path.join(homeDir, 'nano-banana-images');
      }
    }
  }

  private async saveConfig(): Promise<void> {
    if (this.config) {
      const configPath = path.join(process.cwd(), '.nano-banana-config.json');
      await fs.writeFile(configPath, JSON.stringify(this.config, null, 2));
    }
  }

  private async loadConfig(): Promise<void> {
    // Try to load from environment variable first
    const envApiKey = process.env.GEMINI_API_KEY;
    if (envApiKey) {
      try {
        this.config = ConfigSchema.parse({ geminiApiKey: envApiKey });
        this.genAI = new GoogleGenAI({ apiKey: this.config.geminiApiKey });
        this.configSource = 'environment';
        return;
      } catch (error) {
        // Invalid API key in environment
      }
    }
    
    // Fallback to config file
    try {
      const configPath = path.join(process.cwd(), '.nano-banana-config.json');
      const configData = await fs.readFile(configPath, 'utf-8');
      const parsedConfig = JSON.parse(configData);
      
      this.config = ConfigSchema.parse(parsedConfig);
      this.genAI = new GoogleGenAI({ apiKey: this.config.geminiApiKey });
      this.configSource = 'config_file';
    } catch {
      // Config file doesn't exist or is invalid, that's okay
      this.configSource = 'not_configured';
    }
  }

  public async run(): Promise<void> {
    await this.loadConfig();
    
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

const server = new NanoBananaMCP();
server.run().catch(console.error);