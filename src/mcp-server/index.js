/**
 * MCP Server for World Cup 2026 Predictions
 * Exposes tools for Claude to query team stats, confrontations, and predictions.
 * Works only when the NestJS backend is running on localhost:3000.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Create MCP server instance
const server = new Server(
  {
    name: 'wc2026-predictor',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ------------------------------
// List available tools (functions)
// ------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_team_stats',
        description: 'Get complete statistics for a national team by its FBref ID (e.g., "b009a548" for Mexico).',
        inputSchema: {
          type: 'object',
          properties: {
            fbrefId: { type: 'string', description: 'FBref team identifier' },
          },
          required: ['fbrefId'],
        },
      },
      {
        name: 'get_confrontacion',
        description: 'Compare two national teams: stats, recent form, head‑to‑head history, and a quick simulation.',
        inputSchema: {
          type: 'object',
          properties: {
            fbrefId1: { type: 'string', description: 'FBref ID of first team' },
            fbrefId2: { type: 'string', description: 'FBref ID of second team' },
          },
          required: ['fbrefId1', 'fbrefId2'],
        },
      },
      {
        name: 'get_group_predictions',
        description: 'Get current group stage predictions (points, goals, position) for a specific group (A‑L).',
        inputSchema: {
          type: 'object',
          properties: {
            group: { type: 'string', description: 'Group letter (e.g., "A", "B", ... "L")' },
          },
          required: ['group'],
        },
      },
      {
        name: 'get_knockout_bracket',
        description: 'Retrieve the current knockout stage bracket, including round names and predicted winner.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'generate_predictions',
        description: 'Force a fresh simulation of group stage and knockout stage predictions. Use this before asking for updated bracket.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// ------------------------------
// Execute tool calls
// ------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_team_stats': {
        const { fbrefId } = args;
        const response = await axios.get(`${API_BASE_URL}/seleccion/${fbrefId}/stats`);
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case 'get_confrontacion': {
        const { fbrefId1, fbrefId2 } = args;
        const response = await axios.get(
          `${API_BASE_URL}/seleccion/confrontacion/${fbrefId1}/${fbrefId2}`
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case 'get_group_predictions': {
        const { group } = args;
        const response = await axios.get(`${API_BASE_URL}/prediccion/results?group=${group.toUpperCase()}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case 'get_knockout_bracket': {
        const response = await axios.get(`${API_BASE_URL}/prediccion/knockout`);
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }],
        };
      }

      case 'generate_predictions': {
        const response = await axios.post(`${API_BASE_URL}/prediccion/generate`);
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }],
        };
      }

      default:
        throw new Error(`Tool "${name}" not recognized`);
    }
  } catch (error) {
    const errorMessage = error.response?.data?.message || error.message;
    return {
      content: [{ type: 'text', text: `Error calling ${name}: ${errorMessage}` }],
      isError: true,
    };
  }
});

// ------------------------------
// Start the server
// ------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr (Claude Desktop captures stdout for protocol)
  console.error('MCP server running on stdio, connected to backend at', API_BASE_URL);
}

main().catch((err) => {
  console.error('Fatal error in MCP server:', err);
  process.exit(1);
});