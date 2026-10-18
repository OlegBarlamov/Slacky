// Text output: compact, one header line per message, so a model reads it cheaply.
import type { ActivityItem, ConversationView, Message } from '../../shared/types';
import type { Workspace } from './resolve';

export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const indent = (text: string, by = '  ') => text.replace(/^/gm, by);

export function message(ws: Workspace, m: Message, opts: { conv?: boolean; replyTo?: boolean } = {}) {
  const head = [
    opts.conv ? ws.label(m.convId) : null,
    m.id,
    `seq ${m.seq}`,
    `@${ws.userName(m.authorId)}`,
    ago(m.createdAt),
    m.editedAt ? '(edited)' : null,
    opts.replyTo && m.threadRootId ? `in thread ${m.threadRootId}` : null,
  ].filter(Boolean);
  const lines = [head.join('  '), indent(m.deletedAt ? '(deleted)' : m.text)];
  if (m.thread) {
    const who = m.thread.participantIds.map((id) => `@${ws.userName(id)}`).join(', ');
    lines.push(`  └ ${m.thread.replyCount} ${m.thread.replyCount === 1 ? 'reply' : 'replies'}, last ${ago(m.thread.lastReplyAt)} (${who})`);
  }
  return lines.join('\n');
}

export function conversation(ws: Workspace, v: ConversationView) {
  const c = v.conversation;
  const parts = [ws.label(c.id), c.id];
  if (c.kind === 'channel') parts.push(`${c.memberIds.length} ${c.memberIds.length === 1 ? 'member' : 'members'}`);
  else if (c.memberIds.length === 1) parts.push('(you)');
  if (v.unreadCount) parts.push(`${v.unreadCount} unread`);
  if (v.mentionCount) parts.push(`${v.mentionCount} ${v.mentionCount === 1 ? 'mention' : 'mentions'}`);
  return parts.join('  ');
}

export function activity(ws: Workspace, item: ActivityItem) {
  const where = item.threadRootId ? `${ws.label(item.convId)} thread ${item.threadRootId}` : ws.label(item.convId);
  const flags = [item.read ? 'read' : 'unread', item.channelWide ? '@channel' : null, item.state === 'active' ? null : item.state].filter(Boolean);
  const head = `${item.id}  ${item.kind}  ${where}  ${flags.join('  ')}  ${ago(item.updatedAt)}`;
  if (item.state === 'deleted') return `${head}\n  (message was deleted)`;
  const entries = item.entries.map((e) => `  ${e.messageId}  @${ws.userName(e.authorId)}${e.edited ? ' (edited)' : ''}: ${e.text.replace(/\n/g, ' ')}`);
  return [head, ...entries].join('\n');
}
