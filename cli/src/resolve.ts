// Turns what people type (#general, @ben, ids) into ids, using the caller's bootstrap.
import type { Bootstrap, Conversation, ConversationView, Id, User } from '../../shared/types';
import { CliError, type Client, EXIT } from './client';

export class Workspace {
  private constructor(
    private readonly client: Client,
    readonly boot: Bootstrap,
  ) {}

  static async load(client: Client) {
    return new Workspace(client, await client.request<Bootstrap>('GET', '/bootstrap'));
  }

  get me() {
    return this.boot.me;
  }

  userName(id: Id) {
    return this.boot.users.find((u) => u.id === id)?.name ?? id;
  }

  user(ref: string): User {
    const name = ref.replace(/^@/, '').toLowerCase();
    const user = this.boot.users.find((u) => u.id === ref || u.name === name);
    if (!user) throw new CliError(`No user ${ref}`, EXIT.notFound, 'run: slacky users');
    return user;
  }

  /** `#general`, `general` or an id, among channels I'm in and ones I could join. */
  channel(ref: string): Conversation {
    const name = ref.replace(/^#/, '').toLowerCase();
    const all = [...this.boot.conversations.map((v) => v.conversation), ...this.boot.otherChannels];
    const c = all.find((x) => x.kind === 'channel' && (x.id === ref || x.name === name));
    if (!c) throw new CliError(`No channel #${name}`, EXIT.notFound, 'run: slacky channels --joinable');
    return c;
  }

  /** A conversation I'm a member of. `@name` is the DM with that user, if it exists. */
  joined(ref: string): ConversationView {
    if (ref.startsWith('@')) {
      const dm = this.dmWith(this.user(ref).id);
      if (!dm) throw new CliError(`No messages with ${ref} yet`, EXIT.notFound, `run: slacky send ${ref} <text>`);
      return dm;
    }
    const view = this.boot.conversations.find((v) => v.conversation.id === ref);
    if (view) return view;
    const c = this.channel(ref);
    const mine = this.boot.conversations.find((v) => v.conversation.id === c.id);
    if (!mine) throw new CliError(`Not a member of #${c.name}`, EXIT.forbidden, `run: slacky join #${c.name}`);
    return mine;
  }

  /** Like `joined`, but opens the DM when there isn't one yet. */
  async writable(ref: string): Promise<Conversation> {
    if (!ref.startsWith('@')) return this.joined(ref).conversation;
    const user = this.user(ref);
    const existing = this.dmWith(user.id);
    if (existing) return existing.conversation;
    return (await this.client.request<ConversationView>('POST', '/dms', { userId: user.id })).conversation;
  }

  /** How a conversation is shown: `#name`, or `@other` for a DM (`@me` for the self-DM). */
  label(conv: Id | Conversation) {
    const c = typeof conv === 'string' ? [...this.boot.conversations.map((v) => v.conversation), ...this.boot.otherChannels].find((x) => x.id === conv) : conv;
    if (!c) return String(conv);
    if (c.kind === 'channel') return `#${c.name}`;
    const other = c.memberIds.find((id) => id !== this.me.id);
    return other ? `@${this.userName(other)}` : `@${this.me.name}`;
  }

  private dmWith(userId: Id) {
    return this.boot.conversations.find(
      (v) => v.conversation.kind === 'dm' && v.conversation.memberIds.includes(userId) && v.conversation.memberIds.every((id) => id === userId || id === this.me.id),
    );
  }
}
