// MCP 架构（09）—— 最小化实现
//
// 文档 09：MCP（Model Context Protocol）让 agent 接外部工具/资源。
//   - 两种 server 类型：Local（stdio 启子进程）/ Remote（HTTP/SSE）
//   - 五种连接状态：connected / disabled / failed / needs_auth / needs_client_registration
//   - watch 监听变化（自动重连）
//   - OAuth CSRF 防护（oauthState 32 字节随机数）
//   - 子进程递归清理（pgrep -P）
//   - 工具名 sanitize
//
// 真正的 MCP 实现要启子进程或连 HTTP；这里最小实现：
//   - 只支持 Remote（HTTP）和 Embedded（直接调函数）
//   - watch 是简单的状态机
//   - OAuth 留 hook（用户实现）

import { randomBytes } from "node:crypto";
import type { Tool, ToolImpl } from "../tool/tool.js";
import { makeTool } from "../tool/tool.js";

export type McpConnectionState =
  | "connected"
  | "disabled"
  | "failed"
  | "needs_auth"
  | "needs_client_registration";

export interface McpServerConfig {
  name: string;
  enabled?: boolean;
  // local
  command?: string[];
  cwd?: string;
  environment?: Record<string, string>;
  // remote
  url?: string;
  headers?: Record<string, string>;
  oauth?: { disabled?: boolean };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
  // 执行函数
  execute: (args: any) => Promise<unknown>;
}

export interface McpServer {
  config: McpServerConfig;
  state: McpConnectionState;
  error?: string;
  tools: McpTool[];
}

// OAuth state（32 字节随机数，防 CSRF）
// 文档 11：startAuth 时存 oauthState，回调时校验 storedState !== result.oauthState
export class OAuthStateStore {
  private states = new Map<string, string>();

  startAuth(serverName: string): string {
    const state = randomBytes(32).toString("hex");
    this.states.set(serverName, state);
    return state;
  }

  verify(serverName: string, returnedState: string): boolean {
    const stored = this.states.get(serverName);
    if (!stored) return false;
    this.states.delete(serverName);
    return stored === returnedState;
  }
}

// 工具名 sanitize
// 文档 11：sanitize(clientName) + "_" + sanitize(name)，非 [a-zA-Z0-9_-] 替换为 _
export function sanitizeMcpToolName(clientName: string, toolName: string): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${sanitize(clientName)}_${sanitize(toolName)}`;
}

// MCP 注册中心
export class McpRegistry {
  private servers = new Map<string, McpServer>();
  private oauthStates = new OAuthStateStore();

  async registerServer(config: McpServerConfig, tools: McpTool[] = []): Promise<McpServer> {
    const server: McpServer = {
      config,
      state: config.enabled === false ? "disabled" : "connected",
      tools,
    };
    this.servers.set(config.name, server);
    return server;
  }

  // 把 MCP server 的工具注册到 ToolRegistry
  // 文档 11：工具名 sanitize + server 前缀防冲突
  registerTools(
    serverName: string,
    registerFn: (name: string, tool: Tool) => void
  ): void {
    const server = this.servers.get(serverName);
    if (!server || server.state !== "connected") return;
    for (const mt of server.tools) {
      const toolName = sanitizeMcpToolName(serverName, mt.name);
      const impl: ToolImpl = {
        description: mt.description,
        inputSchema: mt.inputSchema,
        async execute(args: any) {
          return mt.execute(args);
        },
      };
      const tool = makeTool(impl);
      registerFn(toolName, tool);
    }
  }

  listServers(): McpServer[] {
    return Array.from(this.servers.values());
  }

  // watch：监听 server 状态变化
  // 文档 09：watch auto-recovery，断了/变了自动响应
  async watch(onChange: (server: McpServer) => void): Promise<void> {
    // 最小实现：定期 poll，状态变了就 onChange
    setInterval(() => {
      for (const server of this.servers.values()) {
        // 这里没有真连接，所以状态不变
        // 真实现会检测连接状态
      }
    }, 5000).unref?.();
  }
}
