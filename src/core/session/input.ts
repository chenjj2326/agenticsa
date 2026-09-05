// Session Input（03）
// 文档 03：用户发消息 → 先持久化成一行（只记录不执行）→ 唤醒执行器。
// 两种 delivery 模式：
//   - steer（插队）：下个 turn 开头全部提升并入 history，重置步数
//   - queue（排队）：等内层循环结束、即将 idle 时取最早一条

import { genId, type SessionMessage, type UserMessage } from "./message.js";
import { SessionHistory } from "./history.js";

export type DeliveryMode = "steer" | "queue";

export interface PromptInput {
  id: string;
  delivery: DeliveryMode;
  text: string;
  createdAt: number;
}

// 创建一个 user message（默认 queue）
export function makeUserMessage(text: string): UserMessage {
  return {
    id: genId("u"),
    seq: 0, // 由 history.append 赋值
    variant: "user",
    text,
    createdAt: Date.now(),
  };
}

// admit 写一行持久化（不执行）
// 调用方决定 delivery：steer 或 queue
export function admitInput(
  history: SessionHistory,
  text: string,
  delivery: DeliveryMode = "queue"
): SessionMessage {
  const msg = makeUserMessage(text);
  if (delivery === "steer") {
    history.admitSteer(msg);
  } else {
    history.admitQueue(msg);
  }
  return msg;
}
