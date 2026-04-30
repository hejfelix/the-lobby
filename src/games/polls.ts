import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

interface Poll {
  id: string;
  authorId: string;
  authorName: string;
  question: string;
  options: string[];
  /** option index per voter id */
  votes: Record<string, number>;
  closed: boolean;
  ts: number;
}

export const PollsGame: Game = {
  id: "polls",
  name: "Quick Polls",
  description: "Ask the room a question. Live tally as votes come in.",
  create(container, net): GameInstance {
    const inst = new PollsInstance(container, net);
    return { unmount: () => inst.destroy() };
  },
};

class PollsInstance {
  private container: HTMLElement;
  private net: Net;
  private ns: GameNamespace;
  private polls: Map<string, Poll> = new Map();
  private listEl!: HTMLDivElement;
  private cleanupFns: Array<() => void> = [];

  constructor(container: HTMLElement, net: Net) {
    this.container = container;
    this.net = net;
    this.ns = net.namespace("polls");

    container.innerHTML = `
      <div class="game-layout polls-layout">
        <aside class="toolbar">
          <div class="tool-group">
            <label>New poll</label>
            <input class="poll-q" placeholder="What's for lunch?" maxlength="120" />
            <textarea class="poll-opts" rows="4" placeholder="One option per line"></textarea>
            <button class="poll-create">Post poll</button>
            <p class="hint">Everyone in the room sees the poll instantly. Multi-choice if there are 2+ options.</p>
          </div>
        </aside>
        <section class="polls-board">
          <div class="polls-list"></div>
          <div class="polls-empty">No polls yet. Create the first one on the left.</div>
        </section>
      </div>
    `;

    const q = <T extends Element>(s: string) => container.querySelector(s) as T;
    this.listEl = q<HTMLDivElement>(".polls-list");
    const qInput = q<HTMLInputElement>(".poll-q");
    const optsInput = q<HTMLTextAreaElement>(".poll-opts");
    q<HTMLButtonElement>(".poll-create").onclick = () => {
      const question = qInput.value.trim();
      const options = optsInput.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!question || options.length < 2) {
        alert("Please enter a question and at least two options.");
        return;
      }
      this.createPoll(question, options);
      qInput.value = "";
      optsInput.value = "";
    };

    this.registerNetwork();
    // Late-join: ask peers for any active polls.
    this.ns.send("sync-request", {});
    this.render();
  }

  private createPoll(question: string, options: string[]) {
    const poll: Poll = {
      id: crypto.randomUUID(),
      authorId: this.net.me.id,
      authorName: this.net.me.name,
      question,
      options: options.slice(0, 8).map((o) => o.slice(0, 80)),
      votes: {},
      closed: false,
      ts: Date.now(),
    };
    this.polls.set(poll.id, poll);
    this.ns.send("new", poll);
    this.render();
  }

  private vote(pollId: string, optionIdx: number) {
    const poll = this.polls.get(pollId);
    if (!poll || poll.closed) return;
    poll.votes[this.net.me.id] = optionIdx;
    this.ns.send("vote", { id: pollId, idx: optionIdx });
    this.render();
  }

  private closePoll(pollId: string) {
    const poll = this.polls.get(pollId);
    if (!poll || poll.authorId !== this.net.me.id) return;
    poll.closed = true;
    this.ns.send("close", { id: pollId });
    this.render();
  }

  private registerNetwork() {
    this.ns.on<Poll>("new", (data, peerId) => {
      if (!data?.id || this.polls.has(data.id)) return;
      const poll: Poll = {
        id: String(data.id).slice(0, 64),
        authorId: peerId,
        authorName: String(data.authorName ?? "anon").slice(0, 24),
        question: String(data.question ?? "").slice(0, 200),
        options: Array.isArray(data.options) ? data.options.slice(0, 8).map((o) => String(o).slice(0, 80)) : [],
        votes: {},
        closed: false,
        ts: Number(data.ts) || Date.now(),
      };
      if (poll.options.length < 2) return;
      this.polls.set(poll.id, poll);
      this.render();
    });

    this.ns.on<{ id: string; idx: number }>("vote", (data, peerId) => {
      const poll = this.polls.get(data?.id);
      if (!poll || poll.closed) return;
      if (typeof data.idx !== "number") return;
      if (data.idx < 0 || data.idx >= poll.options.length) return;
      poll.votes[peerId] = data.idx;
      this.render();
    });

    this.ns.on<{ id: string }>("close", (data, peerId) => {
      const poll = this.polls.get(data?.id);
      if (!poll || poll.authorId !== peerId) return;
      poll.closed = true;
      this.render();
    });

    this.ns.on<Record<string, never>>("sync-request", (_d, peerId) => {
      // Send all active polls authored by *us* to the requester. Other peers
      // will do the same for theirs, so the newcomer learns about everything.
      for (const poll of this.polls.values()) {
        if (poll.authorId === this.net.me.id) {
          this.ns.send("new", poll, peerId);
        }
      }
    });
  }

  private render() {
    const polls = [...this.polls.values()].sort((a, b) => b.ts - a.ts);
    const empty = this.container.querySelector<HTMLDivElement>(".polls-empty");
    if (empty) empty.style.display = polls.length ? "none" : "block";
    this.listEl.innerHTML = "";
    for (const poll of polls) this.listEl.appendChild(this.renderPoll(poll));
  }

  private renderPoll(poll: Poll): HTMLElement {
    const card = document.createElement("article");
    card.className = "poll-card" + (poll.closed ? " closed" : "");
    const totalVotes = Object.keys(poll.votes).length;
    const myVote = poll.votes[this.net.me.id];

    const header = document.createElement("header");
    header.innerHTML = `
      <h3>${escapeHtml(poll.question)}</h3>
      <div class="poll-meta">
        by ${escapeHtml(poll.authorName)} · ${totalVotes} vote${totalVotes === 1 ? "" : "s"}
        ${poll.closed ? "· closed" : ""}
      </div>
    `;
    card.appendChild(header);

    for (let i = 0; i < poll.options.length; i++) {
      const opt = poll.options[i];
      const count = Object.values(poll.votes).filter((v) => v === i).length;
      const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0;
      const row = document.createElement("button");
      row.className = "poll-option" + (myVote === i ? " mine" : "");
      row.disabled = poll.closed;
      row.innerHTML = `
        <div class="bar" style="width:${pct}%"></div>
        <div class="poll-option-text">
          <span class="label">${escapeHtml(opt)}</span>
          <span class="count">${count} · ${pct}%</span>
        </div>
      `;
      row.onclick = () => this.vote(poll.id, i);
      card.appendChild(row);
    }

    if (poll.authorId === this.net.me.id && !poll.closed) {
      const close = document.createElement("button");
      close.className = "poll-close";
      close.textContent = "Close poll";
      close.onclick = () => this.closePoll(poll.id);
      card.appendChild(close);
    }

    return card;
  }

  destroy() {
    for (const fn of this.cleanupFns) fn();
    this.ns.close();
    this.container.innerHTML = "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
}
