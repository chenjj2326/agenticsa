// Session History（02）
//
// 文档 02：history 用两条截断线——
//   - compaction_seq：对话历史的截断点（之前全砍掉换摘要）
//   - baseline_seq：system 消息的截断点（之前已被 baseline 吸收）
// 文档 02：大输出不进 message，message 只带引用 + 截断摘要（ToolOutputStore）。
//
// 最小实现：内存数组。文档里是 SQLite 持久化；这里保持接口干净以便后续换 SQLite。

import type {
  AssistantMessage,
  CompactionMessage,
  SessionMessage,
} from "./message.js";

export interface CompactionRecord {
  seq: number;
  summary: string;
  recentContext: string;
  // compaction 之前的消息被它取代
}

export class SessionHistory {
  private messages: SessionMessage[] = [];
  private seqCounter = 0;
  // 最新 compaction（compaction 之前的消息全砍掉）
  private latestCompaction: CompactionRecord | null = null;
  // baseline_seq：system 消息的截止线（之前的 system 更新已被 baseline 吸收）
  private baselineSeq = 0;
  // input 持久化：admit 写一行（只记录不执行）
  private pendingSteer: SessionMessage[] = [];
  private pendingQueue: SessionMessage[] = [];

  // admit：用户发消息 → 只持久化成一行，唤醒执行器
  admit(msg: SessionMessage) {
    // 默认入 queue，调用方可以改 steer
    this.pendingQueue.push(msg);
  }

  admitSteer(msg: SessionMessage) {
    this.pendingSteer.push(msg);
  }

  admitQueue(msg: SessionMessage) {
    this.pendingQueue.push(msg);
  }

  // 提升 steer：下个 turn 开始时全部提升并入 history，重置步数（外层做）
  promoteSteers(): SessionMessage[] {
    const steers = this.pendingSteer.slice();
    this.pendingSteer = [];
    return steers;
  }

  // 提升 queue：内层循环结束、即将 idle 时取最早一条
  promoteNextQueued(): SessionMessage | null {
    return this.pendingQueue.shift() ?? null;
  }

  hasPendingSteer(): boolean {
    return this.pendingSteer.length > 0;
  }

  hasPendingQueue(): boolean {
    return this.pendingQueue.length > 0;
  }

  // 把消息追加到 history（赋 seq）
  append(msg: SessionMessage): SessionMessage {
    // seq 已赋好且 > 0 的直接用；否则（含 0/undefined/null）自增赋新值
    if (msg.seq && msg.seq > 0) {
      this.seqCounter = Math.max(this.seqCounter, msg.seq);
    } else {
      msg.seq = ++this.seqCounter;
    }
    this.messages.push(msg);
    return msg;
  }

  // 取所有消息（包括被 compaction 截断之前的——用于 revert 等场景）
  all(): SessionMessage[] {
    return this.messages.slice();
  }

  // 取应该进 LLM 上下文的 messages（compaction_seq + baseline_seq 双截断）
  // 返回原 session 消息（外层用 toLLMMessages 转）
  selectForLLM(): SessionMessage[] {
    const compactionSeq = this.latestCompaction?.seq ?? 0;
    const baselineSeq = this.baselineSeq;
    const out: SessionMessage[] = [];
    for (const m of this.messages) {
      // compaction 之前的全砍掉
      if (m.seq <= compactionSeq && m.variant !== "compaction") continue;
      // baseline_seq 之前的 system 消息已被 baseline 吸收
      if (m.variant === "system" && m.seq <= baselineSeq) continue;
      // agent-switched / model-switched 不进上下文
      if (m.variant === "agent-switched" || m.variant === "model-switched")
        continue;
      out.push(m);
    }
    return out;
  }

  // 最近的 assistant 消息（用于成本上报、增量 baseline 等）
  latestAssistant(): AssistantMessage | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.variant === "assistant") return m as AssistantMessage;
    }
    return null;
  }

  // 设置最新 compaction（写入触发 epoch 整体重建，历史从 compaction 之后重开）
  setCompaction(rec: CompactionRecord) {
    this.latestCompaction = rec;
    // 把 compaction summary 作为一条 CompactionMessage 追加
    const compactionMsg: CompactionMessage = {
      id: `compaction_${rec.seq}`,
      seq: rec.seq,
      variant: "compaction",
      summary: rec.summary,
      recentContext: rec.recentContext,
      createdAt: Date.now(),
    };
    this.messages.push(compactionMsg);
  }

  getLatestCompaction(): CompactionRecord | null {
    return this.latestCompaction;
  }

  // 文档 02：baseline_seq 是"system 消息的截止线"
  setBaselineSeq(seq: number) {
    this.baselineSeq = seq;
  }

  getBaselineSeq(): number {
    return this.baselineSeq;
  }

  nextSeq(): number {
    return ++this.seqCounter;
  }
}
